/**
 * EncodedField
 *
 * Field access on an encoded row value: the stored form, which nothing
 * decodes on read (ADR-0014). This module is private.
 * `effect/no-unknown-returns` is off for this module alone, in the root
 * `vite.config.ts`.
 */

import * as P from "effect/Predicate";

/**
 * Top-level field access on a row value: `undefined` for a non-object row or
 * an absent field, `null` for an explicit null. Evaluation treats the two
 * alike (ADR-0028 rule (b): absent ≡ NULL); accelerated evaluators
 * (`CollectionIndex.ts`) read fields with exactly this function so they bucket
 * the same way `evaluate` does.
 *
 * Its type is `unknown` because the row is the encoded form, which no schema
 * has decoded: evaluation compares the field as a raw literal (ADR-0028).
 * Typing rows engine-wide is #696. `Predicate.fieldValue` re-exports it.
 */
export const fieldValue = (row: unknown, field: string): unknown =>
  P.isObjectOrArray(row) ? (row as Record<string, unknown>)[field] : undefined;
