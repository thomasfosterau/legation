/**
 * SyncKey
 *
 * Hierarchical keys that identify cached and synchronized data.
 *
 * A `SyncKey` is an ordered list of parts, e.g. `["users", "1"]` or
 * `["users", { filter: { active: true }, page: 2 }]`. Keys are compared
 * structurally and can be matched by prefix, which is what powers
 * hierarchical invalidation (invalidating `["users"]` invalidates every
 * key that starts with `["users"]`).
 */

/**
 * A single part of a sync key. Objects are compared structurally with
 * key-order-independent equality.
 */
export type SyncKeyPart =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<SyncKeyPart>
  | { readonly [property: string]: SyncKeyPart | undefined };

/**
 * A hierarchical key identifying a piece of synchronized data.
 */
export type SyncKey = ReadonlyArray<SyncKeyPart>;

/**
 * A serialized sync key, suitable for use as a map key or storage key.
 */
export type SyncKeyHash = string;

const stableStringify = (value: SyncKeyPart | undefined): string => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item as SyncKeyPart)).join(",")}]`;
  }
  const record = value as { readonly [property: string]: SyncKeyPart | undefined };
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
};

/**
 * Produce a deterministic string hash for a sync key.
 *
 * Object parts are serialized with sorted property names, so two keys that
 * are structurally equal always hash to the same string regardless of
 * property insertion order.
 */
export const hash = (key: SyncKey): SyncKeyHash =>
  `[${key.map((part) => stableStringify(part)).join(",")}]`;

/**
 * Structural equality between two sync keys.
 */
export const equals = (self: SyncKey, that: SyncKey): boolean =>
  self.length === that.length && hash(self) === hash(that);

/**
 * Returns `true` when `key` starts with `prefix`.
 *
 * Every key is prefixed by the empty key `[]`.
 */
export const startsWith = (key: SyncKey, prefix: SyncKey): boolean => {
  if (prefix.length > key.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(key[index]) !== stableStringify(prefix[index])) {
      return false;
    }
  }
  return true;
};

/**
 * A filter that selects keys, used by invalidation and subscriptions.
 *
 * - `{ prefix }` selects every key starting with `prefix`
 * - `{ exact }` selects only the structurally-equal key
 * - `{ predicate }` selects keys matching an arbitrary predicate
 */
export type KeyFilter =
  | { readonly _tag: "Prefix"; readonly prefix: SyncKey }
  | { readonly _tag: "Exact"; readonly key: SyncKey }
  | { readonly _tag: "Predicate"; readonly predicate: (key: SyncKey) => boolean };

/**
 * Construct a prefix key filter.
 */
export const prefixFilter = (prefix: SyncKey): KeyFilter => ({ _tag: "Prefix", prefix });

/**
 * Construct an exact key filter.
 */
export const exactFilter = (key: SyncKey): KeyFilter => ({ _tag: "Exact", key });

/**
 * Construct a predicate key filter.
 */
export const predicateFilter = (predicate: (key: SyncKey) => boolean): KeyFilter => ({
  _tag: "Predicate",
  predicate,
});

/**
 * Test whether a key matches a filter.
 */
export const matches = (key: SyncKey, filter: KeyFilter): boolean => {
  switch (filter._tag) {
    case "Prefix":
      return startsWith(key, filter.prefix);
    case "Exact":
      return equals(key, filter.key);
    case "Predicate":
      return filter.predicate(key);
  }
};
