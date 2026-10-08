/**
 * SvelteKit server hooks.
 *
 * Two concerns per request, in order:
 *
 * 1. Better Auth handles its own `/api/auth/*` routes (svelteKitHandler)
 *    and resolves the session for everything else — `locals.user`.
 * 2. The client-group binding: when a session user and the browser's
 *    legation client-group cookie are both present, the binding row the
 *    sync engine's `IdentityResolver` reads is kept in sync (bound on
 *    sign-in, unbound on sign-out). This is the only seam between the auth
 *    system and the engine.
 *
 * Process-wide boot (SQL client, schema migration, auth migration) lives in
 * the runtime's layer: layers build once and lazily, so nothing runs at
 * module import — the first request pays for boot, every later request
 * reuses it.
 */
import type { Handle } from "@sveltejs/kit/hooks";
import { Effect, Layer, ManagedRuntime } from "effect";
import { clientLayer, migrate } from "../server/db.js";
import { bindClientGroup, currentUser } from "../server/runtime.js";
import { auth, migrateAuth } from "#lib/server/auth.js";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/env";

const DB_PATH = process.env.COMMERCE_DB ?? new URL("../commerce.db", import.meta.url).pathname;

// The Kit process only needs the SQL client (binding reads/writes); all
// sync serving lives in the sync-server process. Both migrations are layer
// dependencies, so they run exactly once, on first use, not at import.
const database = Layer.mergeAll(
  Layer.effectDiscard(migrate),
  Layer.effectDiscard(Effect.promise(migrateAuth))
).pipe(Layer.provideMerge(clientLayer(DB_PATH)));
const runtime = ManagedRuntime.make(database);

/** Keep the client-group → user binding aligned with the session. */
const alignBinding = (clientGroupId: string | undefined, userId: string | undefined) =>
  Effect.gen(function* () {
    if (clientGroupId === undefined) return;
    const bound = yield* currentUser(clientGroupId);
    if (bound === userId) return;
    yield* bindClientGroup(clientGroupId, userId);
  });

export const handle: Handle = async ({ event, resolve }) => {
  // Force the (memoized) layer build before Better Auth touches its tables.
  await runtime.runPromise(Effect.void);

  const session = await auth.api.getSession({ headers: event.request.headers });
  event.locals.user = session?.user
    ? { id: session.user.id, name: session.user.name, email: session.user.email }
    : undefined;

  // A universal load's in-process `fetch` of the read proxy is a
  // sub-request of a page request that already aligned the binding; it
  // needs the session (the proxy vouches for it) and nothing else.
  if (!event.isSubRequest) {
    await runtime.runPromise(
      alignBinding(event.cookies.get("legation-client-group"), event.locals.user?.id)
    );
  }

  return svelteKitHandler({ auth, event, resolve, building });
};
