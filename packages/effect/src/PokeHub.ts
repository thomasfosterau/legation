/**
 * PokeHub
 *
 * The sync server's poke fan-out: one hub per sync server, keyed by client
 * group. A private piece of `SyncServer`, not on any entry: a carrier reads a
 * group's pokes through `ServerHandler.pokes`.
 */

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Poke } from "./Protocol.js";

/** A poke hub: publish a poke to a client group, or subscribe to a group's pokes. */
export interface PokeHub {
  /** Publish `poke` to every current and next subscriber of `clientGroupId`. */
  readonly publish: (clientGroupId: string, poke: Poke) => Effect.Effect<void>;
  /** The pokes of `clientGroupId`: the latest one first, if any, then each new one. */
  readonly subscribe: (clientGroupId: string) => Stream.Stream<Poke>;
}

/**
 * Build a poke hub: pokes keyed by client group, scoped to the sync server
 * that owns it.
 *
 * Delivery guarantee (#44): one `sliding(1)` PubSub per client group, so a
 * poke storm dedupes. A poke is a contentless "pull soon" hint, so an
 * outstanding, not-yet-consumed poke absorbs any number of fresh ones — the
 * sliding strategy replaces the queued poke rather than growing the queue, and
 * N hints in a tick still deliver at most one queued poke per group. Correctness
 * never depends on the poke: a dropped/collapsed poke only delays the next pull
 * (ADR-0008), which is the correctness path.
 *
 * `replay: 1` on each group's hub keeps the reconnect-race behaviour — a late
 * subscriber (a (re)connecting poke stream) still sees the most recent poke,
 * costing at most a redundant pull. `sliding(1)` already gives the
 * late-subscriber-sees-latest property for active buffers; `replay` extends it
 * across the subscribe gap.
 *
 * Hubs are created lazily per group under a lock (single-flight) and all shut
 * down together when the enclosing scope closes.
 */
export const make: Effect.Effect<PokeHub, never, Scope.Scope> = Effect.gen(function* () {
  const hubs = yield* Ref.make(new Map<string, PubSub.PubSub<Poke>>());
  const lock = yield* Semaphore.make(1);
  // One finalizer shuts every group's hub down when the scope closes.
  yield* Effect.addFinalizer(() =>
    Ref.get(hubs).pipe(
      Effect.flatMap((map) =>
        Effect.forEach([...map.values()], (hub) => PubSub.shutdown(hub), { concurrency: 1 })
      ),
      Effect.asVoid
    )
  );
  // Get-or-create a group's `sliding(1)` hub; the lock makes creation
  // single-flight so concurrent publish/subscribe for a new group share one hub.
  const hubFor = (clientGroupId: string): Effect.Effect<PubSub.PubSub<Poke>> =>
    Semaphore.withPermit(
      lock,
      Effect.gen(function* () {
        const existing = (yield* Ref.get(hubs)).get(clientGroupId);
        if (existing !== undefined) return existing;
        const hub = yield* PubSub.sliding<Poke>({ capacity: 1, replay: 1 });
        yield* Ref.update(hubs, (map) => new Map(map).set(clientGroupId, hub));
        return hub;
      })
    );
  return {
    publish: (clientGroupId, poke) =>
      hubFor(clientGroupId).pipe(Effect.flatMap((hub) => Effect.asVoid(PubSub.publish(hub, poke)))),
    subscribe: (clientGroupId) =>
      Stream.unwrap(hubFor(clientGroupId).pipe(Effect.map((hub) => Stream.fromPubSub(hub)))),
  };
});
