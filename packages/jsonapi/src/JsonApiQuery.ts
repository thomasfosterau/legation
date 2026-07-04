/**
 * JsonApiQuery
 *
 * The seam that turns a `Subset` (predicate + order + paging) into a JSON:API
 * query string. JSON:API deliberately leaves filter/page syntax
 * implementation-defined, so this is the "strictly JSON:API" encoding that a
 * dedicated JSON:API package owns — swap `QueryEncoder` to match your server's
 * conventions (operator filters, cursor pages, sparse fieldsets, …).
 *
 * **Soundness contract.** The backend always re-runs the full predicate, order
 * and limit locally with `Subset.apply`, so an encoder only has to return a
 * *superset* of the desired rows. The shipped default therefore encodes only
 * what it can express without changing the result set:
 *
 * - top-level `eq` / `in` conjuncts → `filter[field]=...` (dropping operators
 *   and `or`/`not` it can't represent makes the server filter *less*
 *   restrictive, which is safe);
 * - `orderBy` → `sort=field,-field` (a hint; local order is authoritative);
 * - it does **not** push `limit`/`cursor`, since server-side paging would drop
 *   rows the local order still needs. An encoder that owns a cursor contract
 *   can add `page[...]`.
 */

import { Predicate } from "@legation/effect";
import { Subset } from "@legation/effect/internal";
import { buildQueryString } from "./CollectionLoader.js";
import type { JsonApiRequestOptions } from "./types.js";

/** Encode a subset into a JSON:API query string (incl. leading `?`, or ``). */
export interface QueryEncoder {
  readonly encode: (subset: Subset.Subset) => string;
}

const literal = (value: Predicate.Literal): string => (value === null ? "null" : String(value));

/** Flatten a predicate's top-level AND into its conjuncts (`True` → none). */
const conjuncts = (predicate: Predicate.Predicate): ReadonlyArray<Predicate.Predicate> => {
  if (predicate._tag === "True") return [];
  if (predicate._tag === "And") return predicate.predicates.flatMap(conjuncts);
  return [predicate];
};

/**
 * The safe `filter` map: equality and membership conjuncts only. Operators
 * (`ne`/`gt`/…), `or`, `not`, and `eq null` are dropped — local `Subset.apply`
 * enforces the exact result over whatever superset the server returns.
 */
const safeFilters = (where: Predicate.Predicate): Record<string, string> => {
  const filter: Record<string, string> = {};
  for (const conjunct of conjuncts(where)) {
    if (conjunct._tag === "Compare" && conjunct.op === "eq" && conjunct.value !== null) {
      filter[conjunct.field] = literal(conjunct.value);
    } else if (conjunct._tag === "In") {
      filter[conjunct.field] = conjunct.values.map(literal).join(",");
    }
  }
  return filter;
};

const sortTerms = (
  subset: Subset.Subset
): ReadonlyArray<{ readonly field: string; readonly direction: "asc" | "desc" }> =>
  subset.orderBy.map((term) => ({ field: term.field, direction: term.direction }));

/**
 * Translate a subset into the JSON:API request options the default encodes.
 * Sort terms are carried in the library's `Query.Sort` decoded shape; the
 * loader serializes them to the `-field,field` wire form on encode.
 */
export const toRequestOptions = (subset: Subset.Subset): JsonApiRequestOptions => {
  const filter = safeFilters(subset.where);
  const sort = sortTerms(subset);
  return {
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(sort.length > 0 ? { sort } : {}),
  };
};

/** The shipped default encoder (sound superset; see module docs). */
export const defaultEncoder: QueryEncoder = {
  encode: (subset) => buildQueryString(toRequestOptions(subset)),
};
