/**
 * SignOut
 *
 * The client half: keep the durable replica scoped to the signed-in user
 * across a session change (#212's identity boundary). When the session's
 * principal changes — sign-out, an account switch, a sign-in —
 * {@link onSessionChange} adopts the new principal's fingerprint with
 * `Client.reset`, whose transition rule decides what survives:
 *
 * - the same user: `Unchanged`, nothing moves;
 * - signed out → signed in: `Upgrade`, the warm replica and its journal stay
 *   (the rows a public session synced are a subset of what the user may read);
 * - anything else, sign-out and account switch included: `Reset` — confirmed
 *   rows, the pull cookie and every subscription are dropped.
 *
 * **The pending journal is quarantined, not flushed and not discarded.** On a
 * reset, unpushed writes move to a quarantine keyed by the superseded user's
 * fingerprint: never pushed under the next session (that would be a forged
 * write), never thrown away (that is the user's data), and pushable again if
 * that user signs back in on this device. A flush first would push them
 * under whatever credentials the transport carries by the time the change is
 * observed, which after a sign-out or an account switch are no longer the
 * author's. An app that wants them sent pushes before it signs out.
 *
 * This module imports no effect-auth runtime, so it is safe in a browser or a
 * service worker; it lives on the package's `./client` entry.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Digest from "effect/crypto/Digest";
import { type Client, Identity } from "@thomasfosterau/legation";
import type { ClientEngine, ClientView } from "@thomasfosterau/legation/internal";

/**
 * What a session change is read from: the signed-in user's id. Both
 * effect-auth's server `SessionWithUser` and its client store's
 * `SessionWithUserView` have this shape.
 */
export interface SessionSubject {
  readonly user: { readonly id: string };
}

/** The domain separator hashed in front of a user id, so the fingerprint is this package's alone. */
const fingerprintDomain = "legation-auth/v1:";

/**
 * The identity fingerprint of a user: `legation-auth:sha256:` and the hex
 * SHA-256 of the user id under this package's domain separator. It is a hash
 * of the session subject, never the id itself (CONTEXT.md, "Identity
 * fingerprint"), and the same user always gets the same one. It needs effect's
 * `Digest` service: provide `Digest.layerWebCrypto` (from `effect/crypto`),
 * which runs on `crypto.subtle` — a browser exposes it only in a secure
 * context.
 */
export const fingerprintOf: (
  userId: string
) => Effect.Effect<Identity.Fingerprint, never, Digest.Digest> = Effect.fn(
  "LegationAuth.fingerprintOf"
)(function* (userId: string) {
  const digest = yield* Digest.Digest;
  const hex = yield* digest.digestHex(
    Digest.sha256,
    new TextEncoder().encode(`${fingerprintDomain}${userId}`)
  );
  return `legation-auth:sha256:${hex}`;
});

/** The fingerprint a session stands for: the user's, or `Identity.anonymous` when signed out. */
const fingerprintOfSession = (
  session: Option.Option<SessionSubject>,
  fingerprint: (
    subject: SessionSubject
  ) => Effect.Effect<Identity.Fingerprint, never, Digest.Digest>
): Effect.Effect<Identity.Fingerprint, never, Digest.Digest> =>
  Option.match(session, {
    onNone: () => Effect.succeed(Identity.anonymous),
    onSome: fingerprint,
  });

/** Options for {@link onSessionChange}. */
export interface SessionChangeOptions {
  /**
   * The fingerprint of a signed-in session. `None` is {@link fingerprintOf}
   * of its user id. Whatever it returns must be the same for every session of
   * one user and different between users, and never PII or a credential.
   */
  readonly fingerprint?: Option.Option<
    (subject: SessionSubject) => Effect.Effect<Identity.Fingerprint, never, Digest.Digest>
  >;
}

/** What one session change did to the replica: the transition `Client.reset` ran, and what it moved. */
export type SessionChange = ClientEngine.ResetOutcome;

/**
 * A session-change listener over a Client: `(previous, next)` with each
 * session as an `Option` (`None` is signed out). It adopts `next`'s
 * fingerprint with `Client.reset`, which compares it with the replica's own
 * stamp — not with `previous` — so a missed or repeated notification can never
 * skip a reset. Unpushed writes of a superseded user are quarantined (see the
 * module docs). Needs effect's `Digest` service for the default fingerprint
 * (`Digest.layerWebCrypto`). Fails as `Client.reset` does, for instance on a Client built
 * with `Client.connect`, whose replica belongs to the engine's host.
 */
export const onSessionChange =
  (client: Client.Client, options?: SessionChangeOptions) =>
  (
    _previous: Option.Option<SessionSubject>,
    next: Option.Option<SessionSubject>
  ): Effect.Effect<SessionChange, ClientView.ClientViewError, Digest.Digest> => {
    const fingerprint = Option.getOrElse(
      Option.flatten(Option.fromNullishOr(options?.fingerprint)),
      () => (subject: SessionSubject) => fingerprintOf(subject.user.id)
    );
    return fingerprintOfSession(next, fingerprint).pipe(Effect.flatMap(client.reset));
  };
