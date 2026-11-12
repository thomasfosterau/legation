/**
 * @thomasfosterau/legation-auth
 *
 * effect-auth for the legation sync engine, server side:
 *
 * - {@link Resolver}: an `Authorization.IdentityResolver` that verifies the
 *   request's session cookie, session token or API key with effect-auth on
 *   every push, pull and read, and fails closed to anonymous;
 * - {@link Principal}: the typed identity it puts on `SyncContext.identity`;
 * - {@link ReadScopes}: effect-auth's compiled read scopes as legation auth
 *   filters, translated exactly or narrowed to `Deny`, never widened.
 *
 * The client half (the sign-out reset) is on `@thomasfosterau/legation-auth/client`,
 * which imports no effect-auth runtime.
 */

export * as Principal from "./Principal.js";
export * as ReadScopes from "./ReadScopes.js";
export * as Resolver from "./Resolver.js";
