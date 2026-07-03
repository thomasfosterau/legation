/**
 * Sign-in/out as plain form actions — the app's auth boundary and part of
 * the no-JS baseline. Both call the sync server's account API (the typed
 * `HttpApiClient` in `locals.api`): signing in binds the browser's client
 * group to the user (`client_groups`), which is what the server-side
 * `IdentityResolver` consults on every push and pull; the client never
 * asserts its own identity. Signing out unbinds — the next pull's auth
 * filters collapse the private subsets to empty allow-sets.
 */
import type { Actions } from "./$types";
import { redirect } from "@sveltejs/kit";
import { Effect } from "effect";
import { clientGroupId } from "@legation/sveltekit";

export const actions: Actions = {
  signin: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    if (username === "") return { error: "enter a username" };
    await Effect.runPromise(
      locals.api.account.signin({
        payload: { username, clientGroupId: clientGroupId(cookies) },
      })
    );
    redirect(303, "/");
  },
  signout: async ({ cookies, locals }) => {
    await Effect.runPromise(
      locals.api.account.signout({ payload: { clientGroupId: clientGroupId(cookies) } })
    );
    redirect(303, "/");
  },
};
