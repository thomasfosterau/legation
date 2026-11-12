/**
 * Principal
 *
 * The identity this package's resolver puts on `SyncContext.identity`: who a
 * push, pull or read was verified to come from. It is one of three cases, and
 * the anonymous one is what every failure resolves to (fail closed):
 *
 * - `Anonymous` — no credential, or a credential that did not verify.
 * - `Session` — a session cookie (or `Authorization: Bearer` session token)
 *   that effect-auth's `SessionService.validateSession` accepted.
 * - `ApiKey` — an API key that effect-auth's `ApiKeyService.verify` accepted.
 *
 * A principal never carries a credential: not the session token (a validated
 * session's `id` is its stored digest, and is left out too), not
 * the API key, not its hash.
 */

import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import type { Session as AuthSession, User } from "@thomasfosterau/effect-auth";
import type { Backend } from "@thomasfosterau/legation";

/** The principal of a request that carried no credential that verified. */
export interface Anonymous {
  readonly _tag: "Anonymous";
}

/** The principal of a request whose session token effect-auth validated. */
export interface Session {
  readonly _tag: "Session";
  /** The signed-in user's id (`user.id`). */
  readonly userId: string;
  /** The user record effect-auth returned with the session. */
  readonly user: User;
  /** The session's stored attributes (for example an active organization id). */
  readonly sessionAttributes: AuthSession["attributes"];
  /** When the validated session expires. */
  readonly expiresAt: Date;
}

/** The principal of a request whose API key effect-auth verified. */
export interface ApiKey {
  readonly _tag: "ApiKey";
  /** The id of the user the key belongs to. */
  readonly userId: string;
  /** The key's record id: never the key, never its hash. */
  readonly keyId: string;
  /** The key's per-resource permissions; `None` when the key is unrestricted. */
  readonly permissions: Option.Option<Readonly<Record<string, ReadonlyArray<string>>>>;
}

/** Who a request was verified to come from: the type of `SyncContext.identity` under this package's resolver. */
export type Principal = Anonymous | Session | ApiKey;

/** The anonymous principal, which every failed or absent credential resolves to. */
export const anonymous: Principal = { _tag: "Anonymous" };

/** Whether a principal is the anonymous one. */
export const isAnonymous = (principal: Principal): principal is Anonymous =>
  P.isTagged(principal, "Anonymous");

/** Whether a principal is a validated session's. */
export const isSession = (principal: Principal): principal is Session =>
  P.isTagged(principal, "Session");

/** The user a principal acts for: `None` for the anonymous principal. */
export const userId = (principal: Principal): Option.Option<string> =>
  Match.valueTags(principal, {
    Anonymous: () => Option.none(),
    Session: (session) => Option.some(session.userId),
    ApiKey: (key) => Option.some(key.userId),
  });

/** Whether a value is a principal this package's resolver produced. */
const isPrincipal = (value: unknown): value is Principal =>
  P.isTagged(value, "Anonymous") ||
  (P.isTagged(value, "Session") && P.hasProperty(value, "userId") && P.isString(value.userId)) ||
  (P.isTagged(value, "ApiKey") && P.hasProperty(value, "userId") && P.isString(value.userId));

/**
 * The principal on a request's `SyncContext`. Anything that is not a principal
 * this package's resolver produced (no resolver, another resolver's identity)
 * reads as {@link anonymous}, so an auth filter built on it fails closed.
 */
export const fromContext = (context: Backend.SyncContext): Principal =>
  isPrincipal(context.identity) ? context.identity : anonymous;
