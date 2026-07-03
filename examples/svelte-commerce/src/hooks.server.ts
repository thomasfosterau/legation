/**
 * SvelteKit server hooks.
 *
 * Three concerns per request, in order:
 *
 * 1. Better Auth handles its own `/api/auth/*` routes (svelteKitHandler)
 *    and resolves the session for everything else — `locals.user`.
 * 2. The client-group binding: when a session user and the browser's
 *    legation client-group cookie are both present, the binding row the
 *    sync engine's `IdentityResolver` reads is kept in sync (bound on
 *    sign-in, unbound on sign-out). This is the only seam between the auth
 *    system and the engine.
 * 3. `locals.api` — the JSON:API client acting as the session user; loads
 *    read through it and form actions write through it.
 *
 * Process-wide state (SQL client, sync handler for the polling safety net,
 * auth migration) is a CACHED Effect: computed once on first request,
 * shared afterwards.
 */
import type { Handle } from "@sveltejs/kit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { clientLayer, migrate } from "../server/db.js";
import { makeApiClient } from "../server/client.js";
import { bindClientGroup, currentUser } from "../server/runtime.js";
import { auth, migrateAuth } from "$lib/server/auth.js";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/environment";

const DB_PATH = process.env.COMMERCE_DB ?? new URL("../commerce.db", import.meta.url).pathname;

// The Kit process only needs the SQL client (binding reads/writes); all
// sync serving lives in the sync-server process.
const database = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(clientLayer(DB_PATH)));
const runtime = ManagedRuntime.make(database);

// One-time process boot as a cached Effect: the first request runs it, every
// later request reuses the result.
const boot = runtime.runSync(
  Effect.cached(
    Effect.promise(migrateAuth)
  )
);

/** Keep the client-group → user binding aligned with the session. */
const alignBinding = (clientGroupId: string | undefined, userId: string | undefined) =>
  Effect.gen(function* () {
    if (clientGroupId === undefined) return;
    const bound = yield* currentUser(clientGroupId);
    if (bound === userId) return;
    yield* bindClientGroup(clientGroupId, userId);
  });

export const handle: Handle = async ({ event, resolve }) => {
  await runtime.runPromise(boot);

  const session = await auth.api.getSession({ headers: event.request.headers });
  event.locals.user = session?.user
    ? { id: session.user.id, name: session.user.name, email: session.user.email }
    : undefined;

  await runtime.runPromise(
    alignBinding(event.cookies.get("legation-client-group"), event.locals.user?.id)
  );

  event.locals.api = await Effect.runPromise(makeApiClient(event.locals.user?.id));

  return svelteKitHandler({ auth, event, resolve, building });
};
