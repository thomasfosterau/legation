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

import { Clock, Effect, Layer, Metric, Ref, Scope } from "effect";
import { Backend, type ChangeHint, type SyncContext } from "./Backend.js";
import {
  AuthPolicy,
  IdentityResolver,
  SyncMiddleware,
  authorize,
  checkFilterable,
  passthroughMiddleware,
} from "./Authorization.js";
import * as Cvr from "./Cvr.js";
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
import { ServerHandler, makePokeHub } from "./Transport.js";
import type { Subset } from "./Subset.js";

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
    for (const id of ids) {
      const row = byId.get(id);
      if (row !== undefined) rows.push({ collection: subset.collection, ...row });
    }
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
    const authorized: Array<Subset> = [];
    for (const subset of checked.subsets) {
      authorized.push(yield* authorize(deps.authPolicy, context, subset, "server"));
    }
    const rows: Array<ReadRow> = [];
    for (const subset of authorized) {
      rows.push(...(yield* evaluateRows(deps.backend, context, subset)));
    }
    return rows;
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
    return onCollection.length > 0 && hintAffects(hint, onCollection, groupCvr);
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
  for (const rows of cvr.rows.values()) total += rows.size;
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
              for (const [clientGroupId, subsets] of groups) {
                if (!collectionMatch(touched, subsets)) continue;
                if (predicateMatch(hints, subsets, cvrs.get(clientGroupId))) {
                  yield* pokeHub.publish(clientGroupId, { reason: undefined });
                  yield* Metric.update(Telemetry.pokesTotal, 1);
                } else {
                  yield* Metric.update(Telemetry.pokesSuppressedTotal, 1);
                }
              }
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
            // mid-push; an interrupt waits for the commit and its publish. Middleware
            // above stays interruptible, since nothing has been committed there.
            const result = yield* Effect.uninterruptible(
              backend
                .applyMutations(context, checked.mutations)
                .pipe(Effect.tap((applied) => bus.publish(applied.hints)))
            );
            return {
              lastMutationIds: result.lastMutationIds,
              ...(result.rejected !== undefined && result.rejected.length > 0
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
      request: PullRequest
    ): Effect.Effect<ReadonlyArray<Subset>, AuthorizationError | TransportError | QueryError> =>
      Effect.gen(function* () {
        const authorized: Array<Subset> = [];
        for (const subset of request.subscriptions) {
          authorized.push(yield* authorize(authPolicy, context, subset, "server"));
        }
        for (const named of request.namedSubscriptions ?? []) {
          authorized.push(
            yield* authorize(authPolicy, context, yield* resolveNamed(context, named), "server")
          );
        }
        return authorized;
      });

    // Evaluate the desired next view: (collection → id → version) per subset.
    const evaluateView = (context: SyncContext, subsets: ReadonlyArray<Subset>) =>
      Effect.gen(function* () {
        const rows = new Map<string, Map<string, string | number>>();
        for (const subset of subsets) {
          const collection = rows.get(subset.collection) ?? new Map<string, string | number>();
          for (const entry of yield* backend.evaluate(context, subset)) {
            collection.set(entry.id, entry.version);
          }
          rows.set(subset.collection, collection);
        }
        return { rows } satisfies Cvr.NextView;
      });

    // Assemble the patch from a CVR diff: a reset clear, then puts (rows fetched
    // per collection) then deletes.
    const assemblePatch = (context: SyncContext, difference: Cvr.CvrDiff, isReset: boolean) =>
      Effect.gen(function* () {
        const patch: Array<PatchOp> = isReset ? [{ _tag: "Clear" }] : [];
        const putsByCollection = new Map<string, Array<string>>();
        for (const put of difference.puts) {
          putsByCollection.set(put.collection, [
            ...(putsByCollection.get(put.collection) ?? []),
            put.id,
          ]);
        }
        for (const [collection, ids] of putsByCollection) {
          for (const row of yield* backend.getRows(context, collection, ids)) {
            patch.push({
              _tag: "Put",
              collection,
              id: row.id,
              version: row.version,
              value: row.value,
            });
          }
        }
        for (const del of difference.dels) {
          patch.push({ _tag: "Del", collection: del.collection, id: del.id });
        }
        return patch;
      });

    // Resolve the CVR the presented cookie names. A cookie minted under a
    // different fleet namespace (a bumped deploy) is treated as unknown, so the
    // pull degrades to a reset patch exactly as an unrecognised cookie does (#48).
    const resolvePrevious = (
      cookie: string | undefined
    ): Effect.Effect<Cvr.Cvr | undefined, StoreError> => {
      if (cookie === undefined) return Effect.succeed(undefined);
      if (cookieNamespaceOf(cookie) !== cookieNamespace) return Effect.succeed(undefined);
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
      cookie: string | undefined
    ) =>
      Effect.gen(function* () {
        const before = yield* backend.lastMutationIds(context);
        const next = yield* evaluateView(context, authorized);
        const previous = yield* resolvePrevious(cookie);
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
      cookie: string | undefined
    ) =>
      Effect.gen(function* () {
        let view = yield* readPullOnce(context, authorized, cookie);
        for (let attempt = 1; !view.consistent && attempt < PULL_VIEW_ATTEMPTS; attempt++) {
          view = yield* readPullOnce(context, authorized, cookie);
        }
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

            const authorized = yield* authorizeAll(context, checked);
            yield* Ref.update(activeSubsets, (m) =>
              new Map(m).set(request.clientGroupId, authorized)
            );

            const { next, patch, lastMutationIds } = yield* readPullView(
              context,
              authorized,
              checked.cookie
            );

            const cookie = yield* freshCookie;
            yield* cvrStore.set(cookie, { rows: next.rows });
            // Track this group's latest view so fan-out can match a delete against
            // the rows the group actually holds (CVR-precise deletes).
            yield* Ref.update(activeCvrs, (m) =>
              new Map(m).set(request.clientGroupId, { rows: next.rows })
            );
            yield* Metric.update(Telemetry.patchOps, patch.length);
            yield* Metric.update(Telemetry.serverPullsTotal, 1);
            return { cookie, patch, lastMutationIds };
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
        for (const [clientGroupId, subsets] of subs) {
          const cvr = cvrs.get(clientGroupId);
          result.push({ clientGroupId, subsets, cvrSize: cvr === undefined ? 0 : cvrSize(cvr) });
        }
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
