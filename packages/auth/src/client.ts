/**
 * @thomasfosterau/legation-auth/client
 *
 * The browser-safe half of legation-auth: {@link SignOut}, which keeps the
 * durable replica scoped to the signed-in user across a session change. It
 * imports no effect-auth runtime.
 */

export * as SignOut from "./SignOut.js";
