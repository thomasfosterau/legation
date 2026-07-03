/**
 * SvelteKit server hooks — one sync stack per server process.
 *
 * The Kit process opens the same SQLite file as the sync server (WAL) and
 * builds its own in-process `ServerHandler` for SSR loads: `loadSnapshot`
 * renders each request over a request-scoped engine against it
 * (`Hydration.snapshot`), no HTTP hop. Writes this process makes (no-JS form
 * actions, sign-ins) are out-of-band from the sync server's perspective —
 * its polling hint source picks them up (ADR-0019 tier 2).
 */
import type { Handle } from "@sveltejs/kit";
import { ManagedRuntime } from "effect";
import { Transport } from "@legation/effect";
import { openDatabase, seed } from "../server/db.js";
import { syncLayer } from "../server/runtime.js";

const DB_PATH = process.env.COMMERCE_DB ?? new URL("../commerce.db", import.meta.url).pathname;

export const db = openDatabase(DB_PATH);
seed(db);

const runtime = ManagedRuntime.make(syncLayer(db));

/** The process-wide ServerHandler, resolved once and stashed per request. */
const handlerPromise: Promise<Transport.ServerHandler> = runtime.runPromise(
  Transport.ServerHandler
);

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.db = db;
  event.locals.handler = await handlerPromise;
  return resolve(event);
};
