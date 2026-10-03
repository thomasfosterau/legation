/**
 * The sync server process (`bun run dev:server`).
 *
 * One Node HTTP server carries three surfaces:
 *
 * - sync RPCs over WebSockets at `/sync-ws` (the live path) and plain HTTP
 *   POST at `/sync` (the fallback `Transport.withFallback` degrades to);
 * - the app's own `HttpApi` under `/api` — sign-in/out and the no-JS
 *   add-to-cart, called by the SvelteKit process, publishing invalidation
 *   hints in-process;
 * - alongside them: the polling hint source (ADR-0019 tier 2) for writes
 *   this process can't see (none in the normal flow anymore, but SSR-side
 *   drift stays covered), and the fulfilment worker — an out-of-band writer
 *   by design, advancing placed orders to shipped/delivered on a timer.
 */
import { Duration, Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import { HintSource } from "@thomasfosterau/legation-effect/internal";
import { HttpSyncServer } from "@thomasfosterau/legation-node";
import { PollingHintSource } from "@thomasfosterau/legation-sql";
import { jsonApiLive } from "./jsonapi.js";
import { clientLayer, makeExecutor, migrate } from "./db.js";
import { tables } from "./handlers.js";
import { CommerceSync, syncLayer } from "./runtime.js";

const PORT = Number(process.env.SYNC_PORT ?? 3100);
const DB_PATH = process.env.COMMERCE_DB ?? new URL("../commerce.db", import.meta.url).pathname;

const carriers = Layer.mergeAll(
  HttpSyncServer.layerWebSocket({ path: "/sync-ws" }),
  HttpSyncServer.layerHttp({ path: "/sync" })
);

/**
 * Advance order statuses on a timer — an out-of-band writer by design. It
 * bypasses mutations entirely, so it announces itself with the one server
 * verb for that (`server.broadcast`, ADR-0022): subscribers are poked
 * immediately instead of waiting for the polling hint source's next tick.
 */
const fulfilment = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const { server } = yield* CommerceSync;
  const advance = Effect.suspend(() => {
    const now = Date.now();
    const shipCutoff = new Date(now - 15_000).toISOString();
    const deliverCutoff = new Date(now - 45_000).toISOString();
    return Effect.andThen(
      sql`UPDATE orders SET status = 'shipped' WHERE status = 'placed' AND createdAt < ${shipCutoff}`,
      sql`UPDATE orders SET status = 'delivered' WHERE status = 'shipped' AND createdAt < ${deliverCutoff}`
    );
  });
  yield* advance.pipe(
    Effect.andThen(server.broadcast({ collection: "orders" })),
    Effect.repeat(Schedule.spaced(Duration.seconds(5))),
    Effect.asVoid
  );
});

/** The client with schema + seed applied before anything depends on it. */
const database = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(clientLayer(DB_PATH)));

const main = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const hints = PollingHintSource.make({
    executor: makeExecutor(sql),
    tables,
    interval: Duration.seconds(2),
  });
  yield* Effect.forkScoped(HintSource.run(hints));
  yield* Effect.forkScoped(fulfilment.pipe(Effect.orDie));
  yield* Effect.log(`commerce sync server on :${PORT} (ws /sync-ws, http /sync, jsonapi /jsonapi)`);
  return yield* Effect.never;
}).pipe(
  Effect.provide(
    HttpRouter.serve(Layer.mergeAll(carriers, jsonApiLive)).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
      Layer.provideMerge(syncLayer),
      Layer.provideMerge(database)
    )
  ),
  Effect.scoped
);

NodeRuntime.runMain(main as Effect.Effect<never, unknown>);
