/**
 * @vitest-environment jsdom
 *
 * BackgroundSync without Background Sync (#213). The API is Chromium-only, so
 * on Safari and Firefox there is no `SyncManager` — and that is the common
 * case, not a fault. Registration reports `"Unsupported"` without logging
 * anything an app would read as an error, and the journal still flushes on
 * the next `BrowserConnectivity` signal.
 *
 * jsdom has no `navigator.serviceWorker` at all, which is itself one of the
 * absent shapes the page-side default must survive.
 */
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@legation/effect";
import { ClientEngine, Cvr, InvalidationBus, Subset, SyncServer } from "@legation/effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Logger, LogLevel, References, Schema, Stream } from "effect";
import * as BackgroundSync from "../BackgroundSync.js";
import * as BrowserConnectivity from "../BrowserConnectivity.js";

/**
 * A logger that records every line at every level (the minimum is lowered to
 * `All`, so debug lines reach it too), split into what an app would surface
 * (`Warn` and above) and the quiet rest.
 */
const recordLogs = () => {
  const loud: Array<string> = [];
  const quiet: Array<string> = [];
  const logger = Logger.make((options) => {
    const line = `${options.logLevel}: ${String(options.message)}`;
    (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Warn") ? loud : quiet).push(line);
  });
  const layer = Layer.merge(
    Logger.layer([logger]),
    Layer.succeed(References.MinimumLogLevel)("All")
  );
  return { loud, quiet, layer };
};

describe("BackgroundSync without Background Sync (#213)", () => {
  it.effect("registration degrades quietly wherever the API is missing or refused", () =>
    Effect.gen(function* () {
      const logs = recordLogs();
      const outcomes = yield* Effect.all([
        // No service worker at all (jsdom, like any page no worker controls).
        BackgroundSync.register(),
        // A registration with no `SyncManager` (Safari, Firefox).
        BackgroundSync.register({ registration: Effect.succeed({}) }),
        // The browser declined (permission withheld, no window, no active worker).
        BackgroundSync.register({
          registration: Effect.succeed({
            sync: { register: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
          }),
        }),
      ]).pipe(Effect.provide(logs.layer));
      expect(outcomes).toEqual(["Unsupported", "Unsupported", "Refused"]);
      // Said, but only at debug level: nothing an app would surface.
      expect(logs.quiet.length).toBeGreaterThan(0);
      expect(logs.loud).toEqual([]);
    })
  );

  it.live("with no SyncManager, the journal still flushes on the next connectivity signal", () =>
    Effect.gen(function* () {
      const logs = recordLogs();
      const setTodo = Mutator.make("todo/set", Schema.Unknown);
      const backend = yield* MemoryBackend.make({
        "todo/set": (args, writer) =>
          Effect.asVoid(writer.put("todos", (args as { id: string }).id, args)),
      });
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
      );
      const base = yield* Transport.makeInMemory(handler, "group-degrade");
      const transport = yield* BrowserConnectivity.withBrowserConnectivity({
        ...base,
        pokes: Stream.empty,
      });
      const store = yield* ClientStore.makeMemory;
      const engine = yield* ClientEngine.make({
        clientId: "client-degrade",
        clientGroupId: "group-degrade",
        mutators: Mutator.registry([
          {
            mutator: setTodo,
            local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
          },
        ]),
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );
      yield* engine.subscribe(Subset.make({ collection: "todos" }));
      yield* engine.runSync;
      yield* Effect.sleep(Duration.millis(20));

      // Offline: the write is journaled, and the registration the app asks
      // for after it finds no SyncManager.
      window.dispatchEvent(new Event("offline"));
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutate("todo/set", { id: "1", title: "offline edit" });
      const outcome = yield* BackgroundSync.register({ registration: Effect.succeed({}) }).pipe(
        Effect.provide(logs.layer)
      );
      expect(outcome).toBe("Unsupported");
      expect(yield* store.pendingMutations).toHaveLength(1);

      // Back online, with the page open: the connectivity path drains it.
      window.dispatchEvent(new Event("online"));
      yield* Effect.sleep(Duration.millis(60));
      expect(yield* store.pendingMutations).toEqual([]);
      expect(logs.loud).toEqual([]);
    }).pipe(Effect.scoped)
  );
});
