/**
 * AtomicKeyValue
 *
 * An optional seam over a key-value store: a batch of `set` and `remove`
 * operations that commits all of its operations or none of them (#393). When
 * it is in context, {@link ClientStore.makeKeyValue} writes a pull's rows, its
 * cookie, its journal trim and its tail release as one batch, with no release
 * record; without it the store keeps the release-record path (#387), so a
 * third-party `KeyValueStore` behaves exactly as before.
 *
 * Effect's `KeyValueStore` has no transactions and no multi-key writes, so the
 * batch is a separate service that a host supplies over the same backing store
 * the `KeyValueStore` reads. The browser's IndexedDB binding is
 * `@thomasfosterau/legation-browser`'s `IndexedDbClientStore`.
 */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { StoreError } from "./Errors.js";

/**
 * One operation of an atomic batch. `key` is the full key the backing store
 * holds, namespace prefix included, exactly as the `KeyValueStore` underneath
 * stores it. `value` is the string the store would hold for a `set`.
 */
export type KeyValueOp =
  | { readonly _tag: "Set"; readonly key: string; readonly value: string }
  | { readonly _tag: "Remove"; readonly key: string };

/** One string entry the backing store holds: its full key and its value. */
export interface KeyValueEntry {
  readonly key: string;
  readonly value: string;
}

/** The {@link AtomicKeyValue} service: an atomic batch over the store's keys. */
export interface AtomicKeyValue {
  /**
   * Commit `ops` in order as one all-or-nothing step. Up to the commit point, a
   * failure or an interruption leaves none of the operations durable. A failure
   * reported after the commit point may still have committed, so a caller must
   * treat that outcome as unknown and re-read the store before relying on it. On
   * success every operation is durable. A later operation on a key replaces an
   * earlier one in the same batch.
   */
  readonly apply: (ops: ReadonlyArray<KeyValueOp>) => Effect.Effect<void, StoreError>;
  /**
   * Every string entry the backing store holds, read in one read transaction, so the
   * result is one state of the store: a batch committed by another connection is
   * either wholly in it or wholly absent (#392). Optional: a store without it reads
   * its keys one at a time, which a concurrent connection can straddle.
   */
  readonly readAll?: Effect.Effect<ReadonlyArray<KeyValueEntry>, StoreError> | undefined;
}

/**
 * The atomic batch seam (#393), optional: a `ClientStore` reads it with
 * `Effect.serviceOption` and falls back to its release-record path when absent.
 */
export const AtomicKeyValue = Context.Service<AtomicKeyValue>(
  "@thomasfosterau/legation-effect/AtomicKeyValue"
);
