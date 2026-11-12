/**
 * Resolver
 *
 * An `Authorization.IdentityResolver` over effect-auth's credential planes:
 * the session plane (`SessionService.validateSession`, from the session
 * cookie or an `Authorization: Bearer` / `Token` session token) and the API
 * key plane (`ApiKeyService.verify`, from an API key header). It reads the
 * credentials from `IdentityRequest.credentials` (ADR-0035), re-validates
 * them on **every** resolve, and puts a {@link Principal.Principal} on
 * `SyncContext.identity`.
 *
 * It **fails closed to anonymous**: an absent, unknown, expired, revoked or
 * disabled credential, a store or transport fault and a defect all resolve to
 * {@link Principal.anonymous}. It never fails the request and never returns a
 * partially trusted principal. A failure is logged by its kind alone: no
 * credential, no header value and no effect-auth error message is logged.
 *
 * Which plane decides: a request that carries an API key header is decided by
 * the API key plane alone, so a key that does not verify makes the request
 * anonymous even when it also carries a valid session cookie. A request
 * without one is decided by the session plane. A plane the resolver was built
 * without resolves its credential to anonymous.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import {
  ApiKeyService,
  SessionResolution,
  SessionService,
  type SessionCookies,
} from "@thomasfosterau/effect-auth";
import { Authorization } from "@thomasfosterau/legation";
import * as Principal from "./Principal.js";

/** The header effect-auth reads a machine API key from by default. */
export const defaultApiKeyHeaders: ReadonlyArray<string> = ["x-api-key"];

/** Options for {@link make} and its layers: the credential names, each defaulting to effect-auth's. */
export interface ResolverOptions {
  /**
   * How the session cookie is named: the same value the app passes effect-auth's
   * HTTP tier, so the resolver derives the same effective name (`__Host-`
   * prefix included). `None` is effect-auth's default naming
   * (`__Host-conduit_session`).
   */
  readonly cookie?: Option.Option<SessionCookies.SessionCookieNaming>;
  /** The headers an API key is read from, in order. `None` is {@link defaultApiKeyHeaders}. */
  readonly apiKeyHeaders?: Option.Option<ReadonlyArray<string>>;
}

/**
 * The effect-auth services the resolver verifies against, one per credential
 * plane. A plane that is `None` resolves its credential to anonymous.
 */
export interface Planes {
  readonly sessions: Option.Option<typeof SessionService.Service>;
  readonly apiKeys: Option.Option<typeof ApiKeyService.Service>;
}

/** Where a resolution failed: a credential plane, or reading the request itself. */
type Plane = "session" | "api-key" | "request";

/** Why a resolution failed closed, for the log line: never a credential or a message. */
type FailureKind = "rejected" | "fault" | "defect";

/** Whether a failure is effect-auth's typed answer for a credential that does not verify, not a fault. */
const isRejection = (error: unknown): boolean =>
  P.isTagged(error, "SessionNotFoundError") ||
  P.isTagged(error, "SessionExpiredError") ||
  P.isTagged(error, "UserNotFoundError");

const failureKind = (cause: Cause.Cause<unknown>): FailureKind =>
  Cause.hasDies(cause)
    ? "defect"
    : Option.exists(Cause.findErrorOption(cause), isRejection)
      ? "rejected"
      : "fault";

/**
 * Fail closed on a cause: the anonymous principal for any failure or defect.
 * An interrupt is not a failure: it ends the request as it is.
 */
const failClosed =
  (plane: Plane) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<Principal.Principal> =>
    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : failedClosed(plane, failureKind(cause));

const failedClosed = (plane: Plane, kind: FailureKind) =>
  Effect.logWarning("legation-auth: identity resolution failed closed to anonymous").pipe(
    Effect.annotateLogs({ plane, kind }),
    Effect.as(Principal.anonymous)
  );

/**
 * A plane's verification, failing closed: any failure or defect becomes the
 * anonymous principal and is logged by its kind only.
 */
const closed = <E>(
  plane: "session" | "api-key",
  verify: Effect.Effect<Principal.Principal, E>
): Effect.Effect<Principal.Principal> => verify.pipe(Effect.catchCause(failClosed(plane)));

/** The session plane: a validated session's principal, without its token. */
const sessionPrincipal = (
  sessions: typeof SessionService.Service,
  token: string
): Effect.Effect<Principal.Principal> =>
  closed(
    "session",
    sessions.validateSession(token).pipe(
      Effect.map(({ session, user }): Principal.Principal => ({
        _tag: "Session",
        userId: user.id,
        user,
        sessionAttributes: session.attributes,
        expiresAt: session.expiresAt,
      }))
    )
  );

/** The API key plane: a verified key's principal, without the key. */
const apiKeyPrincipal = (
  apiKeys: typeof ApiKeyService.Service,
  key: string
): Effect.Effect<Principal.Principal> =>
  closed(
    "api-key",
    apiKeys.verify(key).pipe(
      Effect.flatMap((result) =>
        result.valid && result.apiKey !== undefined
          ? Effect.succeed<Principal.Principal>({
              _tag: "ApiKey",
              userId: result.apiKey.userId,
              keyId: result.apiKey.id,
              permissions: Option.fromNullishOr(result.apiKey.permissions),
            })
          : failedClosed("api-key", "rejected")
      )
    )
  );

/**
 * The credential source effect-auth's extractors read, over only the headers
 * the resolver needs: `cookie`, `authorization` and the API key headers.
 * `RequestCredentials` offers no listing, so each is asked for by name.
 */
const sourceOf = (
  credentials: Authorization.RequestCredentials,
  apiKeyHeaders: ReadonlyArray<string>
): SessionResolution.CredentialSource =>
  SessionResolution.fromHeaders(
    R.fromEntries(
      ["cookie", "authorization", ...apiKeyHeaders].flatMap((name) =>
        Option.toArray(credentials.header(name)).map((value) => [name, value] as const)
      )
    )
  );

/** A present, non-empty credential, or `None`. */
const presentOf = (value: Option.Option<string>): Option.Option<string> =>
  Option.filter(value, (credential) => credential !== "");

/**
 * Build the resolver over the given planes. Every resolve re-validates the
 * request's credential and fails closed to {@link Principal.anonymous}; it
 * never fails.
 */
export const make = (planes: Planes, options?: ResolverOptions): Authorization.IdentityResolver => {
  const apiKeyHeaders = Option.getOrElse(
    Option.flatten(Option.fromNullishOr(options?.apiKeyHeaders)),
    () => defaultApiKeyHeaders
  );
  const naming = Option.getOrUndefined(Option.flatten(Option.fromNullishOr(options?.cookie)));
  const config: SessionResolution.CredentialConfig = { ...naming, apiKeyHeaders };
  const resolveCredentials = (
    credentials: Authorization.RequestCredentials
  ): Effect.Effect<Principal.Principal> => {
    const source = sourceOf(credentials, apiKeyHeaders);
    return Option.match(
      presentOf(Option.fromNullishOr(SessionResolution.extractApiKey(source, config))),
      {
        onSome: (key) =>
          Option.match(planes.apiKeys, {
            onSome: (apiKeys) => apiKeyPrincipal(apiKeys, key),
            onNone: () => failedClosed("api-key", "rejected"),
          }),
        onNone: () =>
          Option.match(
            presentOf(Option.fromNullishOr(SessionResolution.extractSessionToken(source, config))),
            {
              onSome: (token) =>
                Option.match(planes.sessions, {
                  onSome: (sessions) => sessionPrincipal(sessions, token),
                  onNone: () => failedClosed("session", "rejected"),
                }),
              onNone: () => Effect.succeed(Principal.anonymous),
            }
          ),
      }
    );
  };
  return {
    // Reading the headers is plain code; a throw there is a defect like any
    // other, and fails closed with it.
    resolve: ({ credentials }) =>
      Effect.suspend(() => resolveCredentials(credentials)).pipe(
        Effect.catchCause(failClosed("request"))
      ),
  };
};

/**
 * The resolver over both planes, as the `IdentityResolver` service: it needs
 * effect-auth's `SessionService` and `ApiKeyService`.
 */
export const layer = (
  options?: ResolverOptions
): Layer.Layer<Authorization.IdentityResolver, never, SessionService | ApiKeyService> =>
  Layer.effect(
    Authorization.IdentityResolver,
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const apiKeys = yield* ApiKeyService;
      return make({ sessions: Option.some(sessions), apiKeys: Option.some(apiKeys) }, options);
    })
  );

/**
 * The resolver over the session plane alone, as the `IdentityResolver`
 * service: an API key resolves to anonymous.
 */
export const layerSessions = (
  options?: ResolverOptions
): Layer.Layer<Authorization.IdentityResolver, never, SessionService> =>
  Layer.effect(
    Authorization.IdentityResolver,
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      return make({ sessions: Option.some(sessions), apiKeys: Option.none() }, options);
    })
  );
