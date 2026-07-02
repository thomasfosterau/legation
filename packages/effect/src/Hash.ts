/**
 * Hash
 *
 * A stable, order-independent content hash, used as a row version when a
 * backend exposes no native version token (CONTEXT.md: row version). The hash
 * changes iff the canonical value changes — exactly what CVR diffing needs —
 * so adapters that sync plain values (the JSON:API and SQL reference backends)
 * share one implementation here rather than each rolling their own.
 */

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

/**
 * A canonical, key-order-insensitive JSON serialisation: two structurally
 * equal values always produce the same string, whatever the order their keys
 * were written in. The correct basis for cache/subscription keys derived from
 * args objects (where `JSON.stringify` would key on insertion order and split
 * one logical subscription across two entries).
 */
export const canonicalJson = (value: unknown): string => canonical(value);

/** A content-hash row version (FNV-1a over the canonical value). */
export const contentHash = (value: unknown): string => {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};
