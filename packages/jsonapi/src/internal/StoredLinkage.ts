/**
 * StoredLinkage
 *
 * A relationship's linkage as it is stored in a row value
 * (`CollectionLoader.RelationshipRef`). This module is private.
 * `effect/prefer-option-over-null` is off for this module alone, in the root
 * `vite.config.ts`.
 */

/**
 * A relationship as it lands in a row value: linkage only, no documents. An
 * empty to-one is `null`, as JSON:API's resource linkage spells it. The engine
 * never decodes a stored row on read: a typed read is a cast of the stored
 * form (ADR-0014). So this type is the stored JSON itself, and an `Option`
 * here would misdescribe the `null` the store holds.
 */
export type RelationshipRef =
  | { readonly type: string; readonly id: string }
  | ReadonlyArray<{ readonly type: string; readonly id: string }>
  | null;
