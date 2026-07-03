/**
 * Sign-up/in/out as plain form actions over Better Auth — the app's auth
 * boundary and part of the no-JS baseline. `auth.api.*` runs server-side;
 * the `sveltekitCookies` plugin sets the session cookies on the response.
 * The sync engine never sees any of this directly: hooks.server.ts aligns
 * the `client_groups` binding with the session on the next request, which
 * is what the engine's `IdentityResolver` consults.
 */
import type { Actions } from "./$types";
import { fail, redirect } from "@sveltejs/kit";
import { APIError } from "better-auth";
import { auth } from "$lib/server/auth.js";

const submitted = async (request: Request) => {
  const form = await request.formData();
  return {
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    name: String(form.get("name") ?? "").trim(),
  };
};

export const actions: Actions = {
  signup: async ({ request }) => {
    const { email, password, name } = await submitted(request);
    try {
      await auth.api.signUpEmail({
        body: { email, password, name: name === "" ? email : name },
        headers: request.headers,
      });
    } catch (error) {
      if (error instanceof APIError) return fail(400, { error: error.message });
      throw error;
    }
    redirect(303, "/");
  },
  signin: async ({ request }) => {
    const { email, password } = await submitted(request);
    try {
      await auth.api.signInEmail({ body: { email, password }, headers: request.headers });
    } catch (error) {
      if (error instanceof APIError) return fail(400, { error: error.message });
      throw error;
    }
    redirect(303, "/");
  },
  signout: async ({ request }) => {
    await auth.api.signOut({ headers: request.headers }).catch(() => undefined);
    redirect(303, "/");
  },
};
