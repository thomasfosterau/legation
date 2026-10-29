/**
 * SyncServer
 *
 * The library-owned server orchestration (ADR-0009): authorizes
 * subscriptions (deny-by-default auth filters + middleware), delegates
 * mutator execution and subset evaluation to the app's Backend, performs
 * CVR bookkeeping and patch computation, and fans out pokes over the
 * InvalidationBus. Carriers (RpcTransport, HTTP routes, in-memory) bind the
 * resulting ServerHandler.
 *
 * Fan-out matching is predicate-aware: a change hint pokes a client group
 * only when some hinted change plausibly affects one of its subscriptions.
 * A value-carrying PUT matches against the subset predicate, a delete against
 * the group's last-synced CVR; value-less hints and `Exists` predicates fall
 * back to the collection-level match. Soundness first — over-matching is safe
 * (a redundant poke costs an empty pull), under-matching would delay
 * convergence, so anything a single row can't decide matches (ADR-0009).
 */

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { Backend, type ChangeHint, evaluateAll, type SyncContext } from "./Backend.js";
import {
  AuthPolicy,
  IdentityResolver,
  type SetBinder,
  SyncMiddleware,
  authorize,
  checkFilterable,
  passthroughMiddleware,
} from "./Authorization.js";
import * as Cvr from "./Cvr.js";
import * as Hash from "./Hash.js";
import { InvalidationBus } from "./InvalidationBus.js";
import {
  AuthorizationError,
  BackendError,
  QueryError,
  StoreError,
  TransportError,
  VersionNotSupportedError,
} from "./Errors.js";
import type {
  PatchOp,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  ReadRequest,
  ReadResponse,
} from "./Protocol.js";
import * as Predicate from "./Predicate.js";
import * as Query from "./Query.js";
import * as Telemetry from "./Telemetry.js";
// oxlint-disable-next-line effect/no-service-constructor-imports -- the poke hub is a private per-handler instance, not a service; exposing it as one would add a requirement to the public sync-server layers.
import { ServerHandler, makePokeHub } from "./Transport.js";
import type { Subset } from "./Subset.js";
import * as Subsets from "./Subset.js";

const asTransportError = (cause: { readonly message: string }): TransportError =>
  new TransportError({ message: cause.message, cause });

// Whether two `lastMutationIds` watermarks name the same ids at the same values (#286).
const sameWatermark = (
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>
): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((key) => a[key] === b[key]);

/** One row a read returns: its collection beside the backend's `(id, version, value)`. */
export type ReadRow = ReadResponse["rows"][number];

/** What ADR-0025's read needs beside the request: the backend, the policy, and the middleware seam. */
export interface ReadDeps {
  readonly backend: Backend;
  readonly authPolicy: AuthPolicy;
  /** The interception seam; absent means passthrough. */
  readonly middleware?: SyncMiddleware;
}

/**
 * Evaluate one already-authorized subset to its current rows: `evaluate`
 * gives the `(id, version)` set in subset order, `getRows` the values, and
 * the rows are returned in the **evaluated order** — `getRows` promises
 * nothing about order (a SQL `IN` returns whatever the engine likes), and
 * the order is the window's identity (ADR-0026).
 */
const evaluateRows = (
  backend: Backend,
  context: SyncContext,
  subset: Subset
): Effect.Effect<ReadonlyArray<ReadRow>, BackendError> =>
  Effect.gen(function* () {
    const ids = (yield* backend.evaluate(context, subset)).map((entry) => entry.id);
    const fetched = yield* backend.getRows(context, subset.collection, ids);
    const byId = new Map(fetched.map((row) => [row.id, row] as const));
    const rows: Array<ReadRow> = [];
    Arr.forEach(ids, (id) => {
      const row = byId.get(id);
      if (row !== undefined) rows.push({ collection: subset.collection, ...row });
    });
    return rows;
  });

/**
 * ADR-0025's read without its carrier: pull's front half, then
 * `Backend.evaluate` + `getRows`, and nothing else. The subsets are checked
 * against the filterable set as the client's own text (#154), handed to
 * `SyncMiddleware.onRead`, narrowed by the deny-by-default auth filters —
 * every subset before any is evaluated, so a denied subset anywhere in the
 * batch means no backend call at all — then each is evaluated to its
 * current rows in subset order. No cookie, no CVR read or write, no
 * `lastMutationIds`. `handleRead` is this behind the protocol's identity
 * resolution; a derived REST handler is this behind an HTTP request's —
 * one read path, two carriers.
 */
export const readSubsets = (
  deps: ReadDeps,
  context: SyncContext,
  request: ReadRequest
): Effect.Effect<ReadonlyArray<ReadRow>, AuthorizationError | BackendError> =>
  Effect.gen(function* () {
    yield* Effect.forEach(request.subsets, (subset) => checkFilterable(deps.authPolicy, subset), {
      discard: true,
    });
    const onRead = deps.middleware?.onRead;
    const checked = onRead === undefined ? request : yield* onRead(context, request);
    const authorized = yield* Effect.forEach(
      checked.subsets,
      (subset) => authorize(deps.authPolicy, context, subset, "server"),
      { concurrency: 1 }
    );
    const rows = yield* Effect.forEach(
      authorized,
      (subset) => evaluateRows(deps.backend, context, subset),
      { concurrency: 1 }
    );
    return rows.flat();
  });

/**
 * Server construction options (#48). Both default to today's behaviour: an
 * absent `acceptSchemaVersion` accepts every version, and an absent
 * `cookieNamespace` mints bare cookies.
 */
export interface SyncServerOptions {
  /**
   * Schema-version acceptor: decide whether a request's declared
   * `schemaVersion` (possibly `undefined` for an old client) is one this build
   * serves. Returning `false` makes `handlePush`/`handlePull` fail up front with
   * a {@link VersionNotSupportedError} — before applying mutations or computing a
   * patch — so an obsolete build is told to update and the journal is not
   * poisoned. Default: accept everything.
   */
  readonly acceptSchemaVersion?: (version: string | undefined) => boolean;
  /**
   * Fleet cookie-reset namespace (#48). Every cookie this server mints is
   * tagged with this namespace; a presented cookie carrying a *different*
   * namespace is treated as unknown, so its next pull degrades to a reset patch
   * (`Clear` + full puts, exactly as an unrecognised cookie does). Bumping this
   * value on deploy therefore forces every previously-issued cookie to reset in
   * one place — the runtime side of ADR-0014's schema-epoch bump. Default: `""`
   * (bare cookies, today's format).
   */
  readonly cookieNamespace?: string;
}

/** Separator between a cookie's fleet namespace and its monotonic body. */
const COOKIE_NAMESPACE_SEP = "::";

/** The fleet namespace a cookie was minted under (`""` for a bare cookie). */
const cookieNamespaceOf = (cookie: string): string => {
  const index = cookie.indexOf(COOKIE_NAMESPACE_SEP);
  return index === -1 ? "" : cookie.slice(0, index);
};

/** Separator between a cookie's body and its scope epoch (#205). */
const COOKIE_EPOCH_SEP = "~e";
/** A cookie's trailing scope epoch: the separator, then the hex `scopeEpochOf` mints. */
const COOKIE_EPOCH_PATTERN = /~e([0-9a-f]+)$/;

/**
 * The scope epoch a cookie was minted under (#205; `""` when the pull bound no
 * named set, the cookie format before #205).
 */
const cookieEpochOf = (cookie: string): string =>
  // Read only a trailing `~e<hex>`: a separator inside the fleet namespace must
  // not be taken for an epoch, or every pull without one would reset.
  COOKIE_EPOCH_PATTERN.exec(cookie)?.[1] ?? "";

/**
 * A pull's scope epoch (ADR-0015's #205 amendment): a hash of the named sets it
 * bound, by name, with their members, so servers sharing a CVR store agree on
 * it, and it moves exactly when a bound set's members do. `""` when the pull
 * bound no set: such a cookie carries no epoch.
 */
const scopeEpochOf = (bound: HashMap.HashMap<string, BoundSet>): string =>
  HashMap.isEmpty(bound)
    ? ""
    : Hash.contentHash(
        HashMap.toEntries(bound)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, values]) => [
            name,
            Option.match(values, {
              onNone: () => null,
              onSome: (members) =>
                [...members].map((member) => Hash.canonicalJson(member)).toSorted(),
            }),
          ])
      );

/** A bound named set's members: `None` when its resolution failed (it narrows). */
type BoundSet = Option.Option<ReadonlyArray<Predicate.Literal>>;

/** One session's cached named sets, by {@link setKey}. */
type SessionSets = HashMap.HashMap<string, CachedSet>;

/** A cached named set's key: the collection whose scope declares it, and its name. */
const setKey = (collection: string, name: string): string => Hash.canonicalJson([collection, name]);

/**
 * One session's cached resolution of a named set (#205): the members (`None`
 * when the resolver failed), when they were resolved, the collection a write to
 * which makes them stale, and whether one has.
 */
interface CachedSet {
  /** The identity the set was resolved for, canonically serialised. */
  readonly identity: string;
  readonly values: Option.Option<ReadonlyArray<Predicate.Literal>>;
  readonly resolvedAt: number;
  readonly maxAgeMillis: number;
  readonly source: string;
  readonly stale: boolean;
}

// ─── Fan-out matching ────────────────────────────────────────────────────────
//
// Correctness invariant (ADR-0009): over-matching is safe — a redundant poke
// costs an empty pull — but under-matching would delay convergence (the next
// interval pull still recovers it). So every rule below matches when a single
// row can't decide the question.

/** Whether a group's subsets touch any of the hinted collections (today's match). */
const collectionMatch = (touched: ReadonlySet<string>, subsets: ReadonlyArray<Subset>): boolean =>
  subsets.some((subset) => touched.has(subset.collection));

/** Does any hinted PUT value satisfy some subset's predicate? */
const someValueMatches = (
  values: ReadonlyArray<{ readonly value: unknown }>,
  subsets: ReadonlyArray<Subset>
): boolean => values.some(({ value }) => subsets.some((s) => Predicate.test(s.where, value)));

/** Does the group's last-synced view hold a row this hint deletes? */
const someDeleteHeld = (
  hint: ChangeHint,
  putIds: ReadonlySet<string>,
  groupCvr: Cvr.Cvr | undefined
): boolean => {
  const held = groupCvr?.rows.get(hint.collection);
  return held !== undefined && hint.ids.some((id) => !putIds.has(id) && held.has(id));
};

/**
 * Whether one hint plausibly affects some of a group's subsets on the hint's
 * collection. An `Exists` node is relational (a single row can't decide it) and
 * a value-less hint carries no row to test, so both fall back to a match; a
 * value-carrying PUT matches by predicate, a delete by the group's CVR.
 */
const hintAffects = (
  hint: ChangeHint,
  subsets: ReadonlyArray<Subset>,
  groupCvr: Cvr.Cvr | undefined
): boolean => {
  if (subsets.some((s) => Predicate.hasExists(s.where))) return true;
  if (hint.values === undefined) return true;
  const putIds = new Set(hint.values.map((v) => v.id));
  return someValueMatches(hint.values, subsets) || someDeleteHeld(hint, putIds, groupCvr);
};

/**
 * Predicate-level match for a group: some hint on a collection the group
 * subscribes plausibly affects one of its subsets there.
 */
const predicateMatch = (
  hints: ReadonlyArray<ChangeHint>,
  subsets: ReadonlyArray<Subset>,
  groupCvr: Cvr.Cvr | undefined
): boolean =>
  hints.some((hint) => {
    const onCollection = subsets.filter((s) => s.collection === hint.collection);
    return Arr.isReadonlyArrayNonEmpty(onCollection) && hintAffects(hint, onCollection, groupCvr);
  });

// ─── Server introspection ─────────────────────────────────────────────────────

/** One active client group as the server sees it: its authorised subsets and CVR size. */
export interface ServerGroup {
  readonly clientGroupId: string;
  /** The subsets authorised on the group's most recent pull. */
  readonly subsets: ReadonlyArray<Subset>;
  /** Rows tracked in the group's last-synced CVR, summed across collections. */
  readonly cvrSize: number;
}

/**
 * A read-only view of the sync server's live fan-out state (#45): the active
 * client groups with their authorised subsets and CVR sizes, plus poke
 * counters. Reads the handler's internal `activeSubsets`/`activeCvrs` Refs and
 * the `legation_*` poke metrics; does not change fan-out behaviour.
 */
export interface ServerIntrospection {
  /** Active client groups with their authorised subsets and CVR sizes. */
  readonly groups: Effect.Effect<ReadonlyArray<ServerGroup>>;
  /** Total pokes published by fan-out (cumulative counter snapshot). */
  readonly pokesPublished: Effect.Effect<number>;
  /** Total pokes suppressed by predicate matching (cumulative counter snapshot). */
  readonly pokesSuppressed: Effect.Effect<number>;
}

/** Rows a CVR holds, summed across its collections. */
const cvrSize = (cvr: Cvr.Cvr): number => {
  let total = 0;
  Arr.forEach(cvr.rows.values(), (rows) => {
    total += rows.size;
  });
  return total;
};

/** The handler paired with its introspection view. */
export interface ServerHandlerWithIntrospection {
  readonly handler: ServerHandler;
  readonly introspection: ServerIntrospection;
}

/** Build the ServerHandler together with its introspection view (with options, #48). */
export const makeWithIntrospectionWith = (
  options?: SyncServerOptions
): Effect.Effect<
  ServerHandlerWithIntrospection,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus | Scope.Scope
> =>
  Effect.gen(function* () {
    const acceptSchemaVersion = options?.acceptSchemaVersion ?? (() => true);
    const cookieNamespace = options?.cookieNamespace ?? "";
    // Reject an unsupported schema version up front, before any mutation is
    // applied or patch computed, so the journal is never poisoned (#48).
    const checkVersion = (
      version: string | undefined
    ): Effect.Effect<void, VersionNotSupportedError> =>
      acceptSchemaVersion(version)
        ? Effect.void
        : Effect.fail(
            new VersionNotSupportedError({
              schemaVersion: version,
              message: `Schema version ${version ?? "(unset)"} is not supported by this server`,
            })
          );
    const backend = yield* Backend;
    const authPolicy = yield* AuthPolicy;
    const cvrStore = yield* Cvr.CvrStore;
    const bus = yield* InvalidationBus;
    const middleware = (yield* Effect.serviceOption(SyncMiddleware)).pipe((option) =>
      option._tag === "Some" ? option.value : passthroughMiddleware
    );
    // Optional: resolve named-query subscriptions to subsets (Query.ts).
    const resolverOption = yield* Effect.serviceOption(Query.QueryResolver);
    // Optional: resolve the request's identity onto SyncContext.identity.
    const identityOption = yield* Effect.serviceOption(IdentityResolver);

    const contextFor = (clientGroupId: string): Effect.Effect<SyncContext, AuthorizationError> =>
      identityOption._tag === "None"
        ? Effect.succeed({ clientGroupId })
        : identityOption.value
            .resolve(clientGroupId)
            .pipe(Effect.map((identity) => ({ clientGroupId, identity })));

    const pokeHub = yield* makePokeHub;
    // Each session's named-set resolutions (#205), by client group, then by the
    // set's key: the collection whose scope declares it and its name, so two
    // collections that declare different sets under one name never share an
    // entry.
    const setCache = yield* Ref.make(HashMap.empty<string, SessionSets>());
    const sessionSetsOf = (all: HashMap.HashMap<string, SessionSets>, clientGroupId: string) =>
      Option.getOrElse(HashMap.get(all, clientGroupId), () => HashMap.empty<string, CachedSet>());
    // How many writes each source collection has seen (#205). A resolution that
    // overlaps a write to its source is cached as stale, so the write's hint,
    // which found no entry to mark while the resolution was in flight, is not
    // lost until the set's maxAge passes.
    const sourceWrites = yield* Ref.make(HashMap.empty<string, number>());
    const writesTo = (source: string) =>
      Effect.map(Ref.get(sourceWrites), (counts) =>
        Option.getOrElse(HashMap.get(counts, source), () => 0)
      );

    // Bind a named set for a pull, from the session's cache while it is fresh:
    // not marked stale by a write to its source, and younger than its maxAge.
    // Otherwise the set is resolved again and cached; a failed resolution binds
    // nothing (it narrows). Every set bound is recorded in `bound`, which the
    // pull's scope epoch is computed from.
    const cachedBinder =
      (bound: Ref.Ref<HashMap.HashMap<string, BoundSet>>): SetBinder =>
      (context, collection, name, set) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key = setKey(collection, name);
          // A session's cache holds one identity's resolutions. When the identity
          // behind the client group changes (a sign-out, another user), every
          // entry resolved for the previous one is dropped, never served.
          const identity = Hash.canonicalJson(context.identity ?? null);
          const sessionSets = sessionSetsOf(yield* Ref.get(setCache), context.clientGroupId);
          const sameIdentity = HashMap.every(sessionSets, (entry) => entry.identity === identity);
          const cached = sameIdentity
            ? Option.getOrUndefined(HashMap.get(sessionSets, key))
            : undefined;
          const fresh =
            cached !== undefined &&
            !cached.stale &&
            cached.source === set.source &&
            now - cached.resolvedAt < cached.maxAgeMillis;
          const writesBefore = yield* writesTo(set.source);
          const values = fresh ? cached.values : yield* set.resolve(context).pipe(Effect.option);
          if (!fresh) {
            // A write to the source landed while the set resolved: the members may
            // predate it. Cache them as stale, so the next pull resolves again,
            // and poke the session, whose windows do not yet lease the source.
            const overlapped = (yield* writesTo(set.source)) !== writesBefore;
            const entry: CachedSet = {
              identity,
              values,
              resolvedAt: now,
              maxAgeMillis: Duration.toMillis(set.maxAge),
              source: set.source,
              stale: overlapped,
            };
            yield* Ref.update(setCache, (all) => {
              const current = sessionSetsOf(all, context.clientGroupId);
              const kept = HashMap.every(current, (other) => other.identity === identity)
                ? current
                : HashMap.empty<string, CachedSet>();
              return HashMap.set(all, context.clientGroupId, HashMap.set(kept, key, entry));
            });
            if (overlapped) {
              yield* pokeHub.publish(context.clientGroupId, { reason: undefined });
              yield* Metric.update(Telemetry.pokesTotal, 1);
            }
          }
          yield* Ref.update(bound, HashMap.set(key, values));
          return values;
        });

    // Mark every cached set whose source a hint touched stale, and return the
    // client groups that held one, so they are poked (#205): their next pull
    // resolves the set again, and resets if its members moved.
    const staleSets = (touched: HashSet.HashSet<string>) =>
      Ref.modify(
        setCache,
        (all): readonly [HashSet.HashSet<string>, HashMap.HashMap<string, SessionSets>] => {
          const groups = HashSet.fromIterable(
            HashMap.keys(
              HashMap.filter(all, (sets) =>
                HashMap.some(sets, (cached) => HashSet.has(touched, cached.source))
              )
            )
          );
          const next = HashMap.map(all, (sets) =>
            HashMap.map(sets, (cached) =>
              HashSet.has(touched, cached.source) ? { ...cached, stale: true } : cached
            )
          );
          return [groups, HashSet.isEmpty(groups) ? all : next];
        }
      );
    // Active subscriptions per client group, for fan-out matching.
    const activeSubsets = yield* Ref.make(new Map<string, ReadonlyArray<Subset>>());
    // Each group's last-synced view (collection → id → version), for matching a
    // delete against the rows a group actually holds.
    const activeCvrs = yield* Ref.make(new Map<string, Cvr.Cvr>());

    // Monotonic cookie minting, scoped to this handler instead of a module
    // global. The Clock makes the timestamp injectable (TestClock in tests).
    const cookieCounter = yield* Ref.make(0);
    const freshCookie = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const seq = yield* Ref.updateAndGet(cookieCounter, (n) => n + 1);
      const body = `cvr-${now}-${seq}`;
      // Tag the cookie with the fleet namespace so a later namespace bump makes
      // every pre-bump cookie unknown → a reset patch on its next pull (#48).
      return cookieNamespace === "" ? body : `${cookieNamespace}${COOKIE_NAMESPACE_SEP}${body}`;
    });

    // Fan-out loop: hints → poke each group some hinted change plausibly
    // affects. A group the collection-level match would poke but predicate
    // matching rules out is suppressed (counted, never dropped for
    // correctness). Poke-then-pull; correctness never depends on it.
    // Subscribing before `make` returns guarantees the loop sees every hint
    // published after construction, even ones racing the forked fiber's start.
    // The exception is a Redis Streams broker while Redis is unreachable, which
    // may miss a publish that races `subscribe`; a hint so missed only delays the
    // next pull.
    const hintSubscription = yield* bus.subscribe;
    yield* Effect.forkScoped(
      Effect.forever(
        hintSubscription.take.pipe(
          Effect.flatMap((hints) =>
            Effect.gen(function* () {
              const start = yield* Clock.currentTimeMillis;
              const touched = new Set(hints.map((hint) => hint.collection));
              const groups = yield* Ref.get(activeSubsets);
              const cvrs = yield* Ref.get(activeCvrs);
              // A write to a named set's source may move the set (#205): those
              // sessions are poked whatever their windows hold.
              const sources = HashSet.fromIterable(touched);
              yield* Ref.update(sourceWrites, (counts) =>
                HashSet.reduce(sources, counts, (next, collection) =>
                  HashMap.set(
                    next,
                    collection,
                    Option.getOrElse(HashMap.get(next, collection), () => 0) + 1
                  )
                )
              );
              const scoped = yield* staleSets(sources);
              yield* Effect.forEach(
                groups,
                ([clientGroupId, subsets]) =>
                  Effect.gen(function* () {
                    if (HashSet.has(scoped, clientGroupId)) {
                      yield* pokeHub.publish(clientGroupId, { reason: undefined });
                      yield* Metric.update(Telemetry.pokesTotal, 1);
                      return;
                    }
                    if (!collectionMatch(touched, subsets)) return;
                    if (predicateMatch(hints, subsets, cvrs.get(clientGroupId))) {
                      yield* pokeHub.publish(clientGroupId, { reason: undefined });
                      yield* Metric.update(Telemetry.pokesTotal, 1);
                    } else {
                      yield* Metric.update(Telemetry.pokesSuppressedTotal, 1);
                    }
                  }),
                { concurrency: 1, discard: true }
              );
              yield* Metric.update(
                Telemetry.fanoutLatencyMs,
                (yield* Clock.currentTimeMillis) - start
              );
            })
          )
        )
      )
    );

    const handlePush = (
      request: PushRequest
    ): Effect.Effect<PushResponse, TransportError | VersionNotSupportedError> =>
      checkVersion(request.schemaVersion).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const context = yield* contextFor(request.clientGroupId);
            const checked = yield* middleware.onPush(context, request);
            // The commit and the fan-out of its hints are one uninterruptible
            // region (#356): an interrupt landing after the backend commits must
            // not skip the publish, because a replayed retry carries no hints and
            // would never repair the loss. The Backend contract cannot tell
            // "committed" from "not yet", so the whole applyMutations call is
            // protected. Trade-off: a slow applyMutations cannot be cancelled
            // mid-push; an interrupt waits for the commit and its publish. The
            // publish's broker I/O is uninterruptible too, but every broker call is
            // bounded, so a hung broker drops its poke instead of holding the region
            // open: the FanoutBus (its publish and lease registration), the Durable
            // Object shard calls (DurableFanoutBroker), the Redis broker's XADD, and
            // the publish of a custom BusBroker under makeSerialized each take a
            // `timeout` (default 5 seconds). Middleware
            // above stays interruptible, since nothing has been committed there.
            const result = yield* Effect.uninterruptible(
              backend
                .applyMutations(context, checked.mutations)
                .pipe(Effect.tap((applied) => bus.publish(applied.hints)))
            );
            return {
              lastMutationIds: result.lastMutationIds,
              ...(result.rejected !== undefined && Arr.isReadonlyArrayNonEmpty(result.rejected)
                ? { rejected: result.rejected }
                : {}),
            };
          }).pipe(Effect.mapError(asTransportError))
        ),
        Effect.withSpan(Telemetry.span.serverPush)
      );

    // Resolve a named subscription to a subset, or fail if no resolver is set.
    const resolveNamed = (
      context: SyncContext,
      named: { readonly name: string; readonly args: unknown }
    ) =>
      resolverOption._tag === "None"
        ? new TransportError({
            message: `No QueryResolver registered for named subscription "${named.name}"`,
          })
        : resolverOption.value.resolve(named.name, named.args, context);

    // The filterable set (#154) is checked against the client's OWN text —
    // the request as it arrived, before middleware may rewrite it — so what
    // a tenancy middleware ANDs in (a scoping key, an `Exists`) stays
    // server-authored, like the auth filter and a named query's resolution.
    const checkClientSubsets = (
      subsets: ReadonlyArray<Subset>
    ): Effect.Effect<void, AuthorizationError> =>
      Effect.forEach(subsets, (subset) => checkFilterable(authPolicy, subset), {
        discard: true,
      });

    // Authorize middleware-checked subsets and server-resolved named queries
    // alike: AND each with its collection's mandatory filter. Both are
    // server-authored by now (the client's text was checked above), so
    // `authorize` narrows without re-checking.
    const authorizeAll = (
      context: SyncContext,
      request: PullRequest,
      bindSet: SetBinder
    ): Effect.Effect<ReadonlyArray<Subset>, AuthorizationError | TransportError | QueryError> =>
      Effect.gen(function* () {
        const direct = yield* Effect.forEach(
          request.subscriptions,
          (subset) => authorize(authPolicy, context, subset, "server", bindSet),
          { concurrency: 1 }
        );
        const named = yield* Effect.forEach(
          request.namedSubscriptions ?? [],
          (entry) =>
            Effect.gen(function* () {
              return yield* authorize(
                authPolicy,
                context,
                yield* resolveNamed(context, entry),
                "server",
                bindSet
              );
            }),
          { concurrency: 1 }
        );
        return [...direct, ...named];
      });

    // Evaluate the desired next view: (collection → id → version) per subset.
    // The subsets go to the backend together (`Backend.evaluateAll`), so a
    // backend with `evaluateMany` answers the pull in a bounded number of
    // round trips (#505); one without it is asked per subset.
    const evaluateView = (context: SyncContext, subsets: ReadonlyArray<Subset>) =>
      Effect.gen(function* () {
        const evaluated = yield* evaluateAll(backend, context, subsets);
        const rows = new Map<string, Map<string, string | number>>();
        Arr.forEach(subsets, (subset, index) => {
          const collection = rows.get(subset.collection) ?? new Map<string, string | number>();
          Arr.forEach(evaluated[index] ?? [], (entry) => {
            collection.set(entry.id, entry.version);
          });
          rows.set(subset.collection, collection);
        });
        return { rows } satisfies Cvr.NextView;
      });

    // Assemble the patch from a CVR diff: a reset clear, then puts (rows fetched
    // per collection) then deletes.
    const assemblePatch = (context: SyncContext, difference: Cvr.CvrDiff, isReset: boolean) =>
      Effect.gen(function* () {
        const patch: Array<PatchOp> = isReset ? [{ _tag: "Clear" }] : [];
        const putsByCollection = new Map<string, Array<string>>();
        Arr.forEach(difference.puts, (put) => {
          putsByCollection.set(put.collection, [
            ...(putsByCollection.get(put.collection) ?? []),
            put.id,
          ]);
        });
        yield* Effect.forEach(
          putsByCollection,
          ([collection, ids]) =>
            Effect.gen(function* () {
              Arr.forEach(yield* backend.getRows(context, collection, ids), (row) => {
                patch.push({
                  _tag: "Put",
                  collection,
                  id: row.id,
                  version: row.version,
                  value: row.value,
                });
              });
            }),
          { concurrency: 1, discard: true }
        );
        Arr.forEach(difference.dels, (del) => {
          patch.push({ _tag: "Del", collection: del.collection, id: del.id });
        });
        return patch;
      });

    // Resolve the CVR the presented cookie names. A cookie minted under a
    // different fleet namespace (a bumped deploy) is treated as unknown, so the
    // pull degrades to a reset patch exactly as an unrecognised cookie does (#48).
    // So is a cookie minted under another scope epoch (#205): its CVR was
    // computed under another scope, so no patch is computed against it, and a
    // narrowed scope can never leave a row behind on the client.
    const resolvePrevious = (
      cookie: string | undefined,
      epoch: string
    ): Effect.Effect<Cvr.Cvr | undefined, StoreError> => {
      if (cookie === undefined) return Effect.succeed(undefined);
      if (cookieNamespaceOf(cookie) !== cookieNamespace) return Effect.succeed(undefined);
      if (cookieEpochOf(cookie) !== epoch) return Effect.succeed(undefined);
      return cvrStore.get(cookie);
    };

    // How many passes a pull makes over its view before it stops retrying a
    // moving watermark (#286). A pass only repeats when a push committed during
    // it, so a bound of 3 is ample under normal load.
    const PULL_VIEW_ATTEMPTS = 3;

    // One pass over a pull's view: the watermark, the evaluated rows and the
    // patch, then the watermark again. `consistent` is true when the two
    // watermarks agree. Writes nothing: the CVR is recorded once, by the caller,
    // for the view it returns.
    const readPullOnce = (
      context: SyncContext,
      authorized: ReadonlyArray<Subset>,
      cookie: string | undefined,
      epoch: string
    ) =>
      Effect.gen(function* () {
        const before = yield* backend.lastMutationIds(context);
        const next = yield* evaluateView(context, authorized);
        const previous = yield* resolvePrevious(cookie, epoch);
        const isReset = cookie !== undefined && previous === undefined;
        const patch = yield* assemblePatch(context, Cvr.diff(previous ?? Cvr.empty, next), isReset);
        const after = yield* backend.lastMutationIds(context);
        return { next, patch, lastMutationIds: after, consistent: sameWatermark(before, after) };
      });

    // The pull's view as one snapshot (#286), for a backend that meets Backend
    // guarantee 1: a client's `lastMutationId` bumped in the same commit as its
    // effects. Then a watermark that reads the same before and after the rows
    // means no push committed in between: every push the watermark covers is in
    // the rows, and no push is in the rows without being covered. That is the
    // invariant the client's overlay relies on to release an acknowledged
    // mutation without a revert or a double application. A backend that exposes
    // effects before the bump (MemoryBackend today, #341; SqlBackend on D1, #342)
    // can still hand a pull an effect its watermark does not cover; this check
    // cannot see that window.
    //
    // A push that lands mid-read moves the watermark, so the view is read again,
    // up to PULL_VIEW_ATTEMPTS passes. Each pass costs a full evaluation (for
    // JsonApiBackend, an HTTP list per subset, plus its `getRows` cache refresh,
    // which is harmless because a pass evaluates before it fetches). If every
    // pass is disturbed, the last pass's watermark is returned, read after its
    // patch. It may then cover a push whose effects the patch lacks, which is a
    // transient revert until the next pull; it never covers less than the patch
    // carries, so it cannot double-apply.
    const readPullView = (
      context: SyncContext,
      authorized: ReadonlyArray<Subset>,
      cookie: string | undefined,
      epoch: string
    ) =>
      Effect.gen(function* () {
        // Read again while a push commits mid-read, up to PULL_VIEW_ATTEMPTS reads.
        const read = (
          attempt: number
        ): Effect.Effect<
          Effect.Success<ReturnType<typeof readPullOnce>>,
          Effect.Error<ReturnType<typeof readPullOnce>>
        > =>
          Effect.flatMap(readPullOnce(context, authorized, cookie, epoch), (view) =>
            view.consistent || attempt >= PULL_VIEW_ATTEMPTS
              ? Effect.succeed(view)
              : read(attempt + 1)
          );
        const view = yield* read(1);
        if (!view.consistent) {
          yield* Effect.logWarning(
            "SyncServer.handlePull: a push committed on every view pass; returning the watermark read after the patch, so a client may briefly revert an acknowledged mutation",
            { attempts: PULL_VIEW_ATTEMPTS, clientGroupId: context.clientGroupId }
          );
        }
        return view;
      });

    const handlePull = (
      request: PullRequest
    ): Effect.Effect<PullResponse, TransportError | VersionNotSupportedError> =>
      checkVersion(request.schemaVersion).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const context = yield* contextFor(request.clientGroupId);
            yield* checkClientSubsets(request.subscriptions);
            const checked = yield* middleware.onPull(context, request);

            // The named sets this pull binds (#205), for its scope epoch.
            const binding = yield* Ref.make(HashMap.empty<string, BoundSet>());
            const authorized = yield* authorizeAll(context, checked, cachedBinder(binding));
            const bound = yield* Ref.get(binding);
            const epoch = scopeEpochOf(bound);
            // The session holds a lease on each bound set's source as it does on
            // a window (ADR-0015's #205 amendment): the source's collection rides
            // with the group's windows, so a room's fan-out registration (from
            // introspection) leases its topic too.
            const sources = HashMap.toValues(
              HashMap.filter(
                sessionSetsOf(yield* Ref.get(setCache), request.clientGroupId),
                (_, key) => HashMap.has(bound, key)
              )
            ).map((cached) => cached.source);
            const leased = Arr.dedupe(sources).map((collection) => Subsets.make({ collection }));
            yield* Ref.update(activeSubsets, (m) =>
              new Map(m).set(request.clientGroupId, [...authorized, ...leased])
            );

            const { next, patch, lastMutationIds } = yield* readPullView(
              context,
              authorized,
              checked.cookie,
              epoch
            );

            // The permanent rejections this pull's watermark covers (#365). A
            // rejected id is bumped into the watermark, so the client must learn
            // its outcome here, or it would settle the mutation as applied. Each
            // rejection is committed with its id's bump, so it is covered once the
            // watermark reaches the id; the filter keeps the response to that view,
            // even when a push commits between the watermark read and this one.
            const rejected = (yield* backend.rejections(context)).filter(
              (entry) => entry.mutationId <= (lastMutationIds[entry.clientId] ?? 0)
            );

            const minted = yield* freshCookie;
            const cookie = epoch === "" ? minted : `${minted}${COOKIE_EPOCH_SEP}${epoch}`;
            yield* cvrStore.set(cookie, { rows: next.rows });
            // Track this group's latest view so fan-out can match a delete against
            // the rows the group actually holds (CVR-precise deletes).
            yield* Ref.update(activeCvrs, (m) =>
              new Map(m).set(request.clientGroupId, { rows: next.rows })
            );
            yield* Metric.update(Telemetry.patchOps, patch.length);
            yield* Metric.update(Telemetry.serverPullsTotal, 1);
            return {
              cookie,
              patch,
              lastMutationIds,
              ...(Arr.isReadonlyArrayNonEmpty(rejected) ? { rejected } : {}),
            };
          }).pipe(Effect.mapError(asTransportError))
        ),
        Effect.withSpan(Telemetry.span.serverPull)
      );

    // The fallthrough read (ADR-0025): identity, then `readSubsets` — pull's
    // front half (filterable check, middleware, deny-by-default auth), then
    // evaluate + fetch. No cookie, no CVR read or write, no lastMutationIds:
    // a read never perturbs sync state, so the worst it can be is stale
    // (pull stays the correctness path).
    const handleRead = (
      request: ReadRequest
    ): Effect.Effect<ReadResponse, TransportError | VersionNotSupportedError> =>
      checkVersion(request.schemaVersion).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const context = yield* contextFor(request.clientGroupId);
            const rows = yield* readSubsets({ backend, authPolicy, middleware }, context, request);
            return { rows };
          }).pipe(Effect.mapError(asTransportError))
        ),
        Effect.withSpan(Telemetry.span.serverRead)
      );

    const handler = ServerHandler.of({
      handlePush,
      handlePull,
      handleRead,
      pokes: (clientGroupId) => pokeHub.subscribe(clientGroupId),
    });

    const introspection: ServerIntrospection = {
      groups: Effect.gen(function* () {
        const subs = yield* Ref.get(activeSubsets);
        const cvrs = yield* Ref.get(activeCvrs);
        const result: Array<ServerGroup> = [];
        Arr.forEach(subs, ([clientGroupId, subsets]) => {
          const cvr = cvrs.get(clientGroupId);
          result.push({ clientGroupId, subsets, cvrSize: cvr === undefined ? 0 : cvrSize(cvr) });
        });
        return result;
      }),
      pokesPublished: Metric.value(Telemetry.pokesTotal).pipe(Effect.map((state) => state.count)),
      pokesSuppressed: Metric.value(Telemetry.pokesSuppressedTotal).pipe(
        Effect.map((state) => state.count)
      ),
    };

    return { handler, introspection };
  });

/** Build the ServerHandler together with its introspection view (default options). */
export const makeWithIntrospection: Effect.Effect<
  ServerHandlerWithIntrospection,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus | Scope.Scope
> = makeWithIntrospectionWith();

/** Build the ServerHandler with options (#48: schema-version acceptor, fleet cookie namespace). */
export const makeWith = (
  options?: SyncServerOptions
): Effect.Effect<
  ServerHandler,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus | Scope.Scope
> => makeWithIntrospectionWith(options).pipe(Effect.map((built) => built.handler));

/** Build the ServerHandler. */
export const make: Effect.Effect<
  ServerHandler,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus | Scope.Scope
> = makeWith();

/** Layer providing the ServerHandler from Backend + policy + CVR + bus (with options, #48). */
export const layerWith = (
  options?: SyncServerOptions
): Layer.Layer<ServerHandler, never, Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus> =>
  Layer.effect(ServerHandler)(makeWith(options));

/** Layer providing the ServerHandler from Backend + policy + CVR + bus. */
export const layer: Layer.Layer<
  ServerHandler,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus
> = layerWith();
