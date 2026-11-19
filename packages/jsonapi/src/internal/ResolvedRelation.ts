/**
 * ResolvedRelation
 *
 * A relationship resolved against the local mirror
 * (`Relationships.RelatedValue`). This module is private.
 * `effect/prefer-option-over-null` is off for this module alone, in the root
 * `vite.config.ts`.
 */

import type { JsonApiRow } from "../Derive.js";

/**
 * A resolved relationship: a row, a list of rows, `null` (empty linkage), or
 * `undefined` (a to-one whose target is not in the mirror). It follows the
 * core's `Related.RelatedValue`, which `Related.Strategy.resolveRow` must
 * return, which the core's join compares by reference, and which travels the
 * mirror protocol raw. It becomes an `Option` with the core's `Related`, in
 * the Option-everywhere work (owner decision, #562), with the wire encoding
 * unchanged.
 */
export type RelatedValue = JsonApiRow | ReadonlyArray<JsonApiRow> | null | undefined;
