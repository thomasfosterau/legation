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
 * {@link follow} subscribes the listener to effect-auth's client session
 * store, so an app wires nothing by hand; {@link fingerprintOfSession} is the
 * stamp to boot a Client with (`Client.make({ identity })`).
 *
 * This module imports nothing of effect-auth (its root barrel reaches
 * `node:crypto`; its client store is read by shape), so it is safe in a
 * browser or a service worker; it lives on the package's `./client` entry.
 */

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
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

/** How a signed-in session is fingerprinted: {@link fingerprintOf} its user id, unless the app says otherwise. */
export interface FingerprintOptions {
  /**
   * The fingerprint of a signed-in session. Omitted, it is
   * {@link fingerprintOf} of its user id. Whatever it returns must be the same
   * for every session of one user and different between users, and never PII
   * or a credential.
   */
  readonly fingerprint?: (
    subject: SessionSubject
  ) => Effect.Effect<Identity.Fingerprint, never, Digest.Digest>;
}

/**
 * The fingerprint a session stands for: its user's ({@link fingerprintOf}, or
 * `options.fingerprint`), or `Identity.anonymous` when signed out (`None`).
 * The stamp to boot a Client with, `Client.make({ identity })`, once the
 * session it boots under is known — a still-pending store's empty session
 * would reset a signed-in user's warm replica.
 */
export const fingerprintOfSession = (
  session: Option.Option<SessionSubject>,
  options?: FingerprintOptions
): Effect.Effect<Identity.Fingerprint, never, Digest.Digest> =>
  Option.match(session, {
    onNone: () => Effect.succeed(Identity.anonymous),
    onSome: options?.fingerprint ?? ((subject) => fingerprintOf(subject.user.id)),
  });

/** Options for {@link onSessionChange} and {@link follow}. */
export interface SessionChangeOptions extends FingerprintOptions {}

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
  ): Effect.Effect<SessionChange, ClientView.ClientViewError, Digest.Digest> =>
    fingerprintOfSession(next, options).pipe(Effect.flatMap(client.reset));

/**
 * The session store {@link follow} subscribes to, by shape: effect-auth's
 * client `SessionStore` (`createAuthClient(...).session`) is one, read
 * structurally so this entry imports nothing of effect-auth. `data` is the
 * signed-in session, `null` when signed out (effect-auth's spelling); a state
 * still `isPending` is not adopted.
 */
export interface SessionStore {
  readonly get: () => {
    readonly data: SessionSubject | null;
    readonly isPending: boolean;
  };
  readonly subscribe: (listener: () => void) => () => void;
}

/** A running {@link follow}. */
export interface Following {
  /**
   * Wait until every store change notified so far has been adopted, and
   * return the last adoption's outcome (`None` before the store has settled
   * once). It fails as that adoption did. Yield it after signing out, before
   * the next viewer can see the app, to know the replica is reset.
   */
  readonly settled: Effect.Effect<Option.Option<SessionChange>, ClientView.ClientViewError>;
}

/**
 * Keep a Client's replica scoped to an effect-auth client session store for
 * the life of the scope. Every settled state the store notifies, and the one
 * it holds when this starts, is adopted with {@link onSessionChange}, one at a
 * time and in order, with the previous session tracked here. A pending state
 * (the store's first fetch, a refetch in flight) is skipped, so a reload does
 * not read as a sign-out. Fingerprints hash with the `Digest` in context, else
 * with `Digest.layerWebCrypto`. An adoption that fails is logged (its error
 * tag only, never the session) and the next notification tries again: the
 * replica's stamp, not the tracked previous session, decides each transition.
 * Closing the scope unsubscribes.
 */
export const follow: (
  client: Client.Client,
  store: SessionStore,
  options?: SessionChangeOptions
) => Effect.Effect<Following, never, Scope.Scope> = Effect.fn("LegationAuth.SignOut.follow")(
  function* (client: Client.Client, store: SessionStore, options?: SessionChangeOptions) {
    // The Digest in context, else WebCrypto's, built once for the scope.
    const digest = yield* Effect.flatMap(Effect.serviceOption(Digest.Digest), (service) =>
      Option.match(service, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.map(Layer.build(Digest.layerWebCrypto), (built) =>
            Context.get(built, Digest.Digest)
          ),
      })
    );
    const onChange = onSessionChange(client, options);
    const adopt = (previous: Option.Option<SessionSubject>, next: Option.Option<SessionSubject>) =>
      Effect.provideService(onChange(previous, next), Digest.Digest, digest);
    const changes = yield* Queue.unbounded<{
      readonly next: Option.Option<SessionSubject>;
      readonly done: Deferred.Deferred<SessionChange, ClientView.ClientViewError>;
    }>();
    const latest = MutableRef.make(
      Option.none<Deferred.Deferred<SessionChange, ClientView.ClientViewError>>()
    );
    const notify = (): void => {
      const state = store.get();
      if (state.isPending) return;
      const done = Deferred.makeUnsafe<SessionChange, ClientView.ClientViewError>();
      MutableRef.set(latest, Option.some(done));
      Queue.offerUnsafe(changes, { next: Option.fromNullishOr(state.data), done });
    };
    const previous = yield* Ref.make(Option.none<SessionSubject>());
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const { next, done } = yield* Queue.take(changes);
          const exit = yield* Effect.exit(adopt(yield* Ref.getAndSet(previous, next), next));
          if (Exit.isFailure(exit)) {
            yield* Effect.logWarning("legation-auth: session change not adopted").pipe(
              Effect.annotateLogs({
                error: Option.match(Exit.findErrorOption(exit), {
                  onNone: () => "defect",
                  onSome: (error) => error._tag,
                }),
              })
            );
          }
          yield* Deferred.done(done, exit);
        })
      )
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => store.subscribe(notify)),
      (unsubscribe) => Effect.sync(unsubscribe)
    );
    yield* Effect.sync(notify);
    return {
      settled: Effect.suspend(() =>
        Option.match(MutableRef.get(latest), {
          onNone: () => Effect.succeedNone,
          onSome: (done) => Effect.asSome(Deferred.await(done)),
        })
      ),
    };
  }
);
