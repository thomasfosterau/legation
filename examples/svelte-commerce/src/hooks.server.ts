/**
 * SvelteKit server hooks — one sync stack per server process.
 *
 * The Kit process opens the same SQLite file as the sync server (WAL,
 * via the Effect SQL client) and builds its own in-process `ServerHandler`
 * for SSR loads: `loadSnapshot` renders each request over a request-scoped
 * engine against it (`Hydration.snapshot`), no HTTP hop. Writes go the
 * other way: form actions call the sync server's `/api` surface through the
 * derived `HttpApiClient` (`locals.api`), so every write publishes its
 * invalidation hints in the process whose bus pokes live clients.
 */
import type { Handle } from "@sveltejs/kit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Transport } from "@legation/effect";
import { clientLayer, migrate } from "../server/db.js";
import { makeApiClient } from "../server/client.js";
import { currentUser, syncLayer } from "../server/runtime.js";

const DB_PATH = process.env.COMMERCE_DB ?? new URL("../commerce.db", import.meta.url).pathname;

const database = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(clientLayer(DB_PATH)));
const runtime = ManagedRuntime.make(syncLayer.pipe(Layer.provideMerge(database)));

/** Process-wide singletons, resolved once and stashed per request. */
const bootPromise = runtime.runPromise(
  Effect.all({ handler: Transport.ServerHandler, api: makeApiClient })
);

export const handle: Handle = async ({ event, resolve }) => {
  const boot = await bootPromise;
  event.locals.handler = boot.handler;
  event.locals.api = boot.api;
  event.locals.userFor = (clientGroupId) => runtime.runPromise(currentUser(clientGroupId));
  return resolve(event);
};
