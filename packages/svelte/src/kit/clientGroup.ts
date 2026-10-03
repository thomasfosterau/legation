/**
 * Client-group cookie
 *
 * The SSR flow renders under the *browser's* client group id so the snapshot
 * cookie continues that group's CVR conversation (see `Hydration.snapshot` in
 * `@thomasfosterau/legation-effect`). The group id therefore has to be stable per browser and
 * visible to both the server (each `load`) and the client (the engine's
 * `clientGroupId` option) — an ordinary, non-`httpOnly` HTTP cookie.
 *
 * `clientGroupId(cookies)` reads it, minting and setting it on first contact.
 */
import type { Cookies } from "@sveltejs/kit";

/** Options for {@link clientGroupId}. */
export interface ClientGroupOptions {
  /** Cookie name. Default `"legation-client-group"`. */
  readonly name?: string;
  /** Generate a fresh id on first contact. Default `crypto.randomUUID`. */
  readonly generate?: () => string;
  /** Cookie path. Default `"/"`. */
  readonly path?: string;
  /** Cookie lifetime in seconds. Default one year. */
  readonly maxAge?: number;
}

const DEFAULT_NAME = "legation-client-group";
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Read the browser's client group id from its cookie, minting one when
 * absent. Call it in a server `load` (or `handle`) and render the page's
 * snapshot under the returned id; the client boots its engine with the same
 * id (it can read the cookie itself, or take the value from the load data).
 *
 * The cookie is deliberately not `httpOnly` — the client engine needs the
 * same group id. It carries no authority: identity is resolved server-side
 * through the `IdentityResolver` seam, never from this value.
 */
export const clientGroupId = (cookies: Cookies, options?: ClientGroupOptions): string => {
  const name = options?.name ?? DEFAULT_NAME;
  const existing = cookies.get(name);
  if (existing !== undefined && existing !== "") return existing;
  const id = (options?.generate ?? (() => crypto.randomUUID()))();
  cookies.set(name, id, {
    path: options?.path ?? "/",
    httpOnly: false,
    sameSite: "lax",
    maxAge: options?.maxAge ?? ONE_YEAR,
  });
  return id;
};
