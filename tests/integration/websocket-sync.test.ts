/**
 * Cross-package integration tests (issue #15).
 *
 * Exercises the full sync stack over real WebSockets:
 *
 *   client A (core SyncClient + browser WebSocketTransport)
 *     ⇅ ws://localhost
 *   server (node WebSocketServer + core SyncHub/ServerStore/Sessions)
 *     ⇅ ws://localhost
 *   client B (core SyncClient + browser WebSocketTransport)
 *
 * Client A pushes mutations; the server applies them write-through and fans
 * out updates; client B's local cache converges.
 */

import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer, Option } from "effect";
import {
  MemoryCacheStore,
  Outbox,
  Protocol,
  QueryClient,
  ServerStore,
  Sessions,
  SyncCache,
  SyncClient,
  SyncHub,
} from "@thomasfosterau/effect-sync-core";
import { WebSocketTransport } from "@thomasfosterau/effect-sync-browser";
import { WebSocketServer } from "@thomasfosterau/effect-sync-node";

/** The server-side layer stack: SyncHub over in-memory store and sessions. */
const hubLayer = SyncHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer))
);

/**
 * A full client-side stack connected to `url`: SyncClient + QueryClient +
 * Outbox + SyncCache sharing one in-memory store, with the browser WebSocket
 * transport as the connection.
 */
const clientStack = (url: string) =>
  SyncClient.layer().pipe(
    Layer.provideMerge(Layer.mergeAll(SyncCache.layer, Outbox.layer, QueryClient.layer)),
    Layer.provideMerge(MemoryCacheStore.layer()),
    Layer.provideMerge(WebSocketTransport.layer({ url }))
  );

/** Poll a cache key until it appears (or ~5s elapse). */
const awaitCacheEntry = <A>(
  cache: SyncCache.SyncCache,
  key: ReadonlyArray<string>
): Effect.Effect<A, never, never> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const entry = yield* Effect.orDie(cache.peek<A>(key));
      if (Option.isSome(entry)) {
        return entry.value.value;
      }
      yield* Effect.sleep(Duration.millis(100));
    }
    return yield* Effect.die(new Error(`timed out waiting for cache entry ${JSON.stringify(key)}`));
  });

interface Todo {
  readonly title: string;
  readonly done: boolean;
}

describe("WebSocket end-to-end sync", () => {
  it("fans out a mutation from client A to client B's cache over real WebSockets", async () => {
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Start the sync server on an ephemeral port.
          const { port } = yield* WebSocketServer.serve({ port: 0 });
          const url = `ws://127.0.0.1:${port}`;

          // ── Client B: subscribe to ["todos"] and wait for the fan-out ──
          const clientB = Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* SyncClient.SyncClient;
              const cache = yield* SyncCache.SyncCache;

              // Run the background engine (message pump + reconnect watcher).
              yield* Effect.forkScoped(Effect.ignore(sync.runSync));
              yield* Effect.sleep(Duration.millis(200));
              yield* sync.subscribe(Protocol.prefixFilter(["todos"]));

              // Wait until the fan-out lands in the local cache.
              return yield* awaitCacheEntry<Todo>(cache, ["todos", "1"]);
            })
          ).pipe(Effect.provide(clientStack(url)));

          // ── Client A: push a mutation through the sync engine ──
          const clientA = Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* SyncClient.SyncClient;

              yield* Effect.forkScoped(Effect.ignore(sync.runSync));
              yield* Effect.sleep(Duration.millis(200));

              // Mutate locally (data key = the entry's sync key), then push.
              yield* sync.mutateLocal(
                {
                  key: ["todos", "1"],
                  execute: (input: Todo) => Effect.succeed(input),
                },
                { title: "Ship the sync engine", done: false }
              );
              yield* sync.push;

              // Give the PushAck a moment to be processed.
              yield* Effect.sleep(Duration.millis(300));
            })
          ).pipe(Effect.provide(clientStack(url)));

          // B subscribes first, then A pushes, then B's result is collected.
          const fiberB = yield* Effect.forkChild(clientB);
          yield* Effect.sleep(Duration.millis(500));
          yield* clientA;
          return yield* Fiber.join(fiberB);
        })
      ).pipe(Effect.provide(hubLayer)) as Effect.Effect<Todo>
    );

    expect(received).toEqual({ title: "Ship the sync engine", done: false });
  }, 20_000);

  it("delivers the server-applied entry back to the pushing client (PushAck → cache)", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { port } = yield* WebSocketServer.serve({ port: 0 });
          const url = `ws://127.0.0.1:${port}`;
          const hub = yield* SyncHub.SyncHub;

          const clientA = Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* SyncClient.SyncClient;
              const cache = yield* SyncCache.SyncCache;
              const outbox = yield* Outbox.Outbox;

              yield* Effect.forkScoped(Effect.ignore(sync.runSync));
              yield* Effect.sleep(Duration.millis(200));

              yield* sync.mutateLocal(
                {
                  key: ["notes", "a"],
                  execute: (input: { readonly text: string }) => Effect.succeed(input),
                },
                { text: "hello server" }
              );
              yield* sync.push;

              // Wait for the PushAck round trip: the outbox entry should be
              // discarded and the cache should hold the server's canonical
              // entry (with its version).
              for (let attempt = 0; attempt < 50; attempt++) {
                const size = yield* outbox.size;
                if (size === 0) break;
                yield* Effect.sleep(Duration.millis(100));
              }

              const remaining = yield* outbox.size;
              const cached = yield* cache.peek<{ readonly text: string }>(["notes", "a"]);
              return {
                remaining,
                cachedValue: Option.getOrUndefined(cached)?.value,
                cachedVersion: Option.getOrUndefined(cached)?.version,
              };
            })
          ).pipe(Effect.provide(clientStack(url)));

          const clientResult = yield* clientA;

          // The server's store has the entry as the source of truth.
          const serverEntry = yield* Effect.orDie(
            Effect.flatMap(Effect.succeed(hub), () => Effect.serviceOption(ServerStore.ServerStore))
          );

          return { clientResult, hasServerStore: Option.isSome(serverEntry) };
        })
      ).pipe(Effect.provide(hubLayer)) as Effect.Effect<{
        clientResult: {
          remaining: number;
          cachedValue: { readonly text: string } | undefined;
          cachedVersion: string | number | undefined;
        };
        hasServerStore: boolean;
      }>
    );

    // The outbox drained after the PushAck and the cache holds the
    // server-acknowledged entry with the server-assigned version 1.
    expect(result.clientResult.remaining).toBe(0);
    expect(result.clientResult.cachedValue).toEqual({ text: "hello server" });
    expect(result.clientResult.cachedVersion).toBe(1);
  }, 20_000);
});
