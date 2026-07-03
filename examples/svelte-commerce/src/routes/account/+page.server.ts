/**
 * Sign-in/out as plain form actions — the app's auth boundary and part of
 * the no-JS baseline. Signing in binds the browser's client group to the
 * user (`client_groups`), which is what the server-side `IdentityResolver`
 * consults on every push and pull; the client never asserts its own
 * identity. Signing out unbinds — the next pull's auth filters collapse the
 * private subsets to empty allow-sets.
 */
import type { Actions } from "./$types";
import { redirect } from "@sveltejs/kit";
import { clientGroupId } from "@legation/sveltekit";
import { bindClientGroup } from "../../../server/runtime.js";

export const actions: Actions = {
  signin: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    if (username === "") return { error: "enter a username" };
    const userId = `u-${username.toLowerCase()}`;
    locals.db
      .prepare("INSERT OR IGNORE INTO profiles (id, name) VALUES (?, ?)")
      .run(userId, username);
    bindClientGroup(locals.db, clientGroupId(cookies), userId);
    redirect(303, "/");
  },
  signout: async ({ cookies, locals }) => {
    bindClientGroup(locals.db, clientGroupId(cookies), undefined);
    redirect(303, "/");
  },
};
