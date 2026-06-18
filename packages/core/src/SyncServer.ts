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
 * Phase-1 fan-out matching is collection-granular: a change hint pokes
 * every client group whose subscriptions touch the hinted collections.
 * Predicate-level matching is a planned refinement.
 */

import { Clock, Effect, Layer, Metric, Ref, Scope } from "effect";
import { Backend, type SyncContext } from "./Backend.js";
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
import * as Query from "./Query.js";
import * as Telemetry from "./Telemetry.js";
import { ServerHandler, makePokeHub } from "./Transport.js";
import type { Subset } from "./Subset.js";

const asTransportError = (cause: { readonly message: string }): TransportError =>
  new TransportError({ message: cause.message, cause });

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

  // Monotonic cookie minting, scoped to this handler instead of a module
  // global. The Clock makes the timestamp injectable (TestClock in tests).
  const cookieCounter = yield* Ref.make(0);
  const freshCookie = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const seq = yield* Ref.updateAndGet(cookieCounter, (n) => n + 1);
    return `cvr-${now}-${seq}`;
  });

  // Fan-out loop: hints → poke groups whose subscriptions touch the
  // hinted collections. Poke-then-pull; correctness never depends on it.
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
            for (const [clientGroupId, subsets] of groups) {
              if (subsets.some((subset) => touched.has(subset.collection))) {
                yield* pokeHub.publish(clientGroupId, { reason: undefined });
                yield* Metric.update(Telemetry.pokesTotal, 1);
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
      return { lastMutationIds: result.lastMutationIds };
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
