/**
 * The sync server process (`bun run dev:server` / `node --experimental-sqlite`).
 *
 * Serves the sync RPCs over BOTH carriers on one Node HTTP server:
 * WebSockets at `/sync-ws` (the live path) and plain HTTP POST at `/sync`
 * (the fallback `Transport.withFallback` degrades to). Alongside the server
 * it runs:
 *
 * - the polling hint source (ADR-0019 tier 2): the SvelteKit process writes
 *   the same SQLite file from no-JS form actions and sign-ins — out-of-band
 *   writers this process only sees by polling, which publishes hints so
 *   subscribers get poked;
 * - the fulfilment worker: advances placed orders to shipped/delivered on a
 *   timer, an out-of-band writer inside this process (also covered by
 *   polling), driving the app's order-status notifications.
 */
import { Duration, Effect, Layer, Schedule } from "effect";
import { HintSource, Transport } from "@legation/effect";
import { HttpSyncServer } from "@legation/node";
import { PollingHintSource } from "@legation/sql";
import { HttpRouter } from "effect/unstable/http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { createServer } from "node:http";
import { openDatabase, makeExecutor, seed } from "./db.js";
import { tables } from "./handlers.js";
import { syncLayer } from "./runtime.js";

const PORT = Number(process.env.SYNC_PORT ?? 3100);
const DB_PATH = process.env.COMMERCE_DB ?? new URL("../commerce.db", import.meta.url).pathname;

const db = openDatabase(DB_PATH);
seed(db);

const carriers = Layer.mergeAll(
  HttpSyncServer.layerWebSocket({ path: "/sync-ws" }),
  HttpSyncServer.layerHttp({ path: "/sync" })
);

const hints = PollingHintSource.make({
  executor: makeExecutor(db),
  tables,
  interval: Duration.seconds(2),
});

/** Advance order statuses on a timer — an out-of-band writer by design. */
const fulfilment = Effect.suspend(() =>
  Effect.sync(() => {
    db.prepare(
      "UPDATE orders SET status = 'shipped' WHERE status = 'placed' AND createdAt < ?"
    ).run(new Date(Date.now() - 15_000).toISOString());
    db.prepare(
      "UPDATE orders SET status = 'delivered' WHERE status = 'shipped' AND createdAt < ?"
    ).run(new Date(Date.now() - 45_000).toISOString());
  })
).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(5))), Effect.asVoid);

const main = Effect.gen(function* () {
  yield* Effect.forkScoped(HintSource.run(hints));
  yield* Effect.forkScoped(fulfilment);
  yield* Effect.log(`commerce sync server on :${PORT} (ws /sync-ws, http /sync)`);
  return yield* Effect.never;
}).pipe(
  Effect.provide(
    HttpRouter.serve(carriers).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
      Layer.provideMerge(syncLayer(db))
    )
  ),
  Effect.scoped
);

NodeRuntime.runMain(main as Effect.Effect<never, unknown>);
