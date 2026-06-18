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

import { Effect, Layer, Metric, Ref, Scope } from "effect";
import { Backend, type SyncContext } from "./Backend.js";
import { AuthPolicy, SyncMiddleware, authorize, passthroughMiddleware } from "./Authorization.js";
import * as Cvr from "./Cvr.js";
import { InvalidationBus } from "./InvalidationBus.js";
import { TransportError } from "./Errors.js";
import type { PatchOp, PullRequest, PullResponse, PushRequest, PushResponse } from "./Protocol.js";
import * as Query from "./Query.js";
import * as Telemetry from "./Telemetry.js";
import { ServerHandler, makePokeHub } from "./Transport.js";
import type { Subset } from "./Subset.js";

let cookieCounter = 0;
const freshCookie = (): string => `cvr-${Date.now()}-${++cookieCounter}`;

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

  const pokeHub = yield* makePokeHub;
  // Active subscriptions per client group, for fan-out matching.
  const activeSubsets = yield* Ref.make(new Map<string, ReadonlyArray<Subset>>());

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
      const context: SyncContext = { clientGroupId: request.clientGroupId };
      const checked = yield* middleware.onPush(context, request);
      const result = yield* backend.applyMutations(context, checked.mutations);
      yield* bus.publish(result.hints);
      return { lastMutationIds: result.lastMutationIds };
    }).pipe(Effect.mapError(asTransportError), Effect.withSpan(Telemetry.span.serverPush));

  const handlePull = (request: PullRequest): Effect.Effect<PullResponse, TransportError> =>
    Effect.gen(function* () {
      const context: SyncContext = { clientGroupId: request.clientGroupId };
      const checked = yield* middleware.onPull(context, request);

      // Authorize: AND each subset with its collection's mandatory filter.
      // Client-authored subsets and server-resolved named queries are treated
      // identically once resolved.
      const authorized: Array<Subset> = [];
      for (const subset of checked.subscriptions) {
        authorized.push(yield* authorize(authPolicy, context, subset));
      }
      for (const named of checked.namedSubscriptions ?? []) {
        if (resolverOption._tag === "None") {
          return yield* new TransportError({
            message: `No QueryResolver registered for named subscription "${named.name}"`,
          });
        }
        const subset = yield* resolverOption.value.resolve(named.name, named.args, context);
        authorized.push(yield* authorize(authPolicy, context, subset));
      }
      yield* Ref.update(activeSubsets, (m) => {
        const next = new Map(m);
        next.set(request.clientGroupId, authorized);
        return next;
      });

      // Evaluate the desired next view.
      const nextRows = new Map<string, Map<string, string | number>>();
      for (const subset of authorized) {
        const entries = yield* backend.evaluate(context, subset);
        const rows = nextRows.get(subset.collection) ?? new Map<string, string | number>();
        for (const entry of entries) rows.set(entry.id, entry.version);
        nextRows.set(subset.collection, rows);
      }
      const next: Cvr.NextView = { rows: nextRows };

      // Diff against what the client holds (unknown cookie → reset).
      const previous =
        checked.cookie === undefined ? undefined : yield* cvrStore.get(checked.cookie);
      const isReset = checked.cookie !== undefined && previous === undefined;
      const difference = Cvr.diff(previous ?? Cvr.empty, next);

      // Assemble the patch: fetch put rows per collection.
      const patch: Array<PatchOp> = isReset ? [{ _tag: "Clear" }] : [];
      const putsByCollection = new Map<string, Array<string>>();
      for (const put of difference.puts) {
        const ids = putsByCollection.get(put.collection) ?? [];
        ids.push(put.id);
        putsByCollection.set(put.collection, ids);
      }
      for (const [collection, ids] of putsByCollection) {
        const rows = yield* backend.getRows(context, collection, ids);
        for (const row of rows) {
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

      const cookie = freshCookie();
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
