/**
 * Identity
 *
 * The client half of the identity boundary. Identity itself is resolved
 * **server-side, per pull** (`Authorization.IdentityResolver`) — that is what
 * makes the auth filter trustworthy — but the durable replica a client keeps
 * on the device has to record *which* resolved identity authorised the rows
 * it holds, or the next principal to open the app boots onto them.
 *
 * The invariant (CONTEXT.md, "Identity boundary"): **a durable replica
 * belongs to exactly one resolved identity, and an identity change is a
 * reset, not a rebase.**
 *
 * The engine's handle on that identity is a {@link Fingerprint}: an opaque,
 * app-supplied token the store stamps beside the rows and compares on boot.
 * Everything else here is the transition rule — the single decision, applied
 * identically at boot (`ClientStore` open) and at runtime
 * (`Client.reset`), that says whether a replica survives an identity change.
 */

/**
 * An opaque token standing for "who this replica belongs to".
 *
 * **Never PII and never a credential.** The obvious wrong things to pass are
 * a user id, an email address, a session token, or a JWT: this value is
 * written to durable device storage (IndexedDB in a browser), read back on
 * every boot, and — when used for namespacing — appears in store key
 * prefixes and database names. Pass a **hash of the session subject** (for
 * example `sha256(issuer + subject)` truncated), computed by the app.
 *
 * The engine never parses, interprets, or transmits a fingerprint; it only
 * ever compares two of them for equality. Two sessions of the same principal
 * must produce the same fingerprint, and two different principals must not
 * — that is the whole contract.
 *
 * Values beginning with `@legation/` are **reserved** for the sentinels
 * below; an app-computed fingerprint must not use that prefix.
 */
export type Fingerprint = string;

/**
 * The signed-out principal: the replica holds only what a public, unauthenticated
 * session may read. Pass this explicitly while no one is signed in — it is what
 * makes the anonymous → signed-in {@link Transition} ("Upgrade") representable,
 * and a replica stamped anonymous is the only one a sign-in is allowed to keep.
 */
export const anonymous: Fingerprint = "@legation/anonymous";

/**
 * The implied fingerprint of a store that has never been stamped — a replica
 * written by a build (or a configuration) with no identity boundary, whose
 * rows could belong to anyone.
 *
 * It is never equal to a real fingerprint and never equal to
 * {@link anonymous}, so adopting *any* identity over an unstamped replica is
 * a reset. That costs one full re-pull the first time an app turns identity
 * scoping on, which is the safe direction: an unstamped replica is exactly
 * the state this boundary exists to distrust.
 */
export const unstamped: Fingerprint = "@legation/unstamped";

/**
 * What adopting a new fingerprint over the stamped one does to the replica.
 *
 * - `Unchanged` — same principal; nothing happens.
 * - `Upgrade` — anonymous → signed in. **The one benign transition**: the
 *   rows a public session synced are a subset of what the new identity may
 *   read, so the warm replica (and the journal — the same person made those
 *   writes on this device moments earlier) survives. Needlessly discarding
 *   here would be a real regression on the commonest first-sign-in path.
 * - `Reset` — every other change, sign-out included. Rows, cookie and
 *   subscriptions go; unpushed journal entries are quarantined under the
 *   superseded fingerprint rather than discarded or adopted.
 */
export type Transition = "Unchanged" | "Upgrade" | "Reset";

/**
 * The transition rule, in one place, so boot and runtime cannot disagree
 * about it. `current` is the stamped fingerprint, or {@link unstamped} when
 * the store carries no stamp.
 */
export const transitionOf = (current: Fingerprint, next: Fingerprint): Transition => {
  if (current === next) return "Unchanged";
  return current === anonymous && next !== unstamped ? "Upgrade" : "Reset";
};

/**
 * A fingerprint rendered safe to embed in a storage key — a store key
 * prefix, an IndexedDB database name — for the namespacing alternative to
 * resetting (`IndexedDbClientStore.layerNamespaced`). Percent-encoding keeps
 * two distinct fingerprints distinct.
 */
export const keySegment = (fingerprint: Fingerprint): string => encodeURIComponent(fingerprint);
