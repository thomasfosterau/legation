/**
 * Better Auth over the same SQLite file as the commerce data (its own
 * tables, created by `migrateAuth` at boot). Sessions are cookie-based and
 * SvelteKit-integrated: `sveltekitCookies` lets form actions call
 * `auth.api.*` server-side and still set the browser's cookies, which keeps
 * the no-JS baseline intact.
 *
 * Identity flows from here into the sync engine via the `client_groups`
 * binding (hooks.server.ts): Better Auth authenticates the browser; the
 * binding ties the browser's client group to the authenticated user; the
 * engine's `IdentityResolver` consults the binding on every push and pull.
 * The client never asserts its own identity anywhere.
 */
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { getRequestEvent } from "$app/server";

const DB_PATH = process.env.COMMERCE_DB ?? new URL("../../../commerce.db", import.meta.url).pathname;

export const auth = betterAuth({
  database: new Database(DB_PATH),
  emailAndPassword: { enabled: true },
  plugins: [sveltekitCookies(getRequestEvent)],
});

/** Create Better Auth's tables (idempotent). */
export const migrateAuth = async (): Promise<void> => {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
};
