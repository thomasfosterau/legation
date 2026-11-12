/**
 * Request credentials
 *
 * The server's `IdentityResolver` resolves a request's identity from the
 * credentials its transport request carried (ADR-0035). A SvelteKit `load` or
 * form action that renders or writes through the in-process server has a
 * request, so it hands that request's headers on: `loadSnapshot`'s and
 * `runFormMutation`'s `credentials` option takes {@link requestCredentials}'s
 * result. Only the resolver reads them; they never reach `SyncContext`.
 */
import * as Option from "effect/Option";
import { Authorization } from "@thomasfosterau/legation";

/** The part of SvelteKit's `RequestEvent` read here: its request's headers. */
export interface CredentialedEvent {
  readonly request: { readonly headers: Headers };
}

/**
 * The credentials a SvelteKit request carries (its session cookie, an
 * `authorization` header), ready for a `credentials` option.
 */
export const requestCredentials = (
  event: CredentialedEvent
): Option.Option<Authorization.RequestCredentials> =>
  Option.some(Authorization.credentialsFromHeaders(event.request.headers));
