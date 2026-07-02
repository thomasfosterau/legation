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
  passthroughMiddleware,
} from "./Authorization.js";
import * as Cvr from "./Cvr.js";
import { InvalidationBus } from "./InvalidationBus.js";
import { AuthorizationError, QueryError, TransportError } from "./Errors.js";
import type { PatchOp, PullRequest, PullResponse, PushRequest, PushResponse } from "./Protocol.js";
import * as Predicate from "./Predicate.js";
import * as Query from "./Query.js";
import * as Telemetry from "./Telemetry.js";
import { ServerHandler, makePokeHub } from "./Transport.js";
import type { Subset } from "./Subset.js";

const asTransportError = (cause: { readonly message: string }): TransportError =>
  new TransportError({ message: cause.message, cause });

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

/** Build the ServerHandler. */
export const make: Effect.Effect<
  ServerHandler,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus | Scope.Scope
> = Effect.gen(function* () {
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
    return `cvr-${now}-${seq}`;
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
          })
        )
      )
    )
  );

  const handlePush = (request: PushRequest): Effect.Effect<PushResponse, TransportError> =>
    Effect.gen(function* () {
      const context = yield* contextFor(request.clientGroupId);
      const checked = yield* middleware.onPush(context, request);
      const result = yield* backend.applyMutations(context, checked.mutations);
      yield* bus.publish(result.hints);
      return {
        lastMutationIds: result.lastMutationIds,
        ...(result.rejected !== undefined && result.rejected.length > 0
          ? { rejected: result.rejected }
          : {}),
      };
    }).pipe(Effect.mapError(asTransportError), Effect.withSpan(Telemetry.span.serverPush));

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

  // Authorize client-authored subsets and server-resolved named queries
  // identically: AND each with its collection's mandatory filter.
  const authorizeAll = (
    context: SyncContext,
    request: PullRequest
  ): Effect.Effect<ReadonlyArray<Subset>, AuthorizationError | TransportError | QueryError> =>
    Effect.gen(function* () {
      const authorized: Array<Subset> = [];
      for (const subset of request.subscriptions) {
        authorized.push(yield* authorize(authPolicy, context, subset));
      }
      for (const named of request.namedSubscriptions ?? []) {
        authorized.push(yield* authorize(authPolicy, context, yield* resolveNamed(context, named)));
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

  const handlePull = (request: PullRequest): Effect.Effect<PullResponse, TransportError> =>
    Effect.gen(function* () {
      const context = yield* contextFor(request.clientGroupId);
      const checked = yield* middleware.onPull(context, request);

      const authorized = yield* authorizeAll(context, checked);
      yield* Ref.update(activeSubsets, (m) => new Map(m).set(request.clientGroupId, authorized));

      const next = yield* evaluateView(context, authorized);
      const previous =
        checked.cookie === undefined ? undefined : yield* cvrStore.get(checked.cookie);
      const isReset = checked.cookie !== undefined && previous === undefined;
      const patch = yield* assemblePatch(context, Cvr.diff(previous ?? Cvr.empty, next), isReset);

      const cookie = yield* freshCookie;
      yield* cvrStore.set(cookie, { rows: next.rows });
      // Track this group's latest view so fan-out can match a delete against
      // the rows the group actually holds (CVR-precise deletes).
      yield* Ref.update(activeCvrs, (m) =>
        new Map(m).set(request.clientGroupId, { rows: next.rows })
      );
      const lastMutationIds = yield* backend.lastMutationIds(context);
      yield* Metric.update(Telemetry.patchOps, patch.length);
      yield* Metric.update(Telemetry.serverPullsTotal, 1);
      return { cookie, patch, lastMutationIds };
    }).pipe(Effect.mapError(asTransportError), Effect.withSpan(Telemetry.span.serverPull));

  return ServerHandler.of({
    handlePush,
    handlePull,
    pokes: (clientGroupId) => pokeHub.subscribe(clientGroupId),
  });
});

/** Layer providing the ServerHandler from Backend + policy + CVR + bus. */
export const layer: Layer.Layer<
  ServerHandler,
  never,
  Backend | AuthPolicy | Cvr.CvrStore | InvalidationBus
> = Layer.effect(ServerHandler)(make);
