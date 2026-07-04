/**
 * FanoutTopics
 *
 * The pure topic algebra of ADR-0023: fan-out is publish/subscribe over
 * **derived topics**, and the fan-out layer never evaluates a predicate.
 * For a node type `C` the topic space is the coarse topic `C` plus fine
 * topics `C/field=value`, allowed only for fields in the node's
 * **derivable set** (its `one`-edge keys + declared `hintKeys`) — declared
 * on the Node, so registration and write-derivation cannot disagree.
 *
 * Soundness by construction: a window registers the finest topic its
 * predicate legally allows (an equality conjunct on a derivable field),
 * and a write emits every derivable-set topic for its **old and new**
 * values — so any write that can affect a fine-registered window emits
 * that window's topic. Over-poking is harmless (pull is the correctness
 * path); under-poking is impossible.
 */

import type * as Node from "./Node.js";
import type * as Predicate from "./Predicate.js";
import type * as Subset from "./Subset.js";

/** A fan-out topic: `collection` (coarse) or `collection/field=value` (fine). */
export type Topic = string;

/** The coarse topic of a collection: every write to it publishes here. */
export const coarse = (collection: string): Topic => collection;

/** A fine topic: a graph location (`reviews/productId=p-1` IS that edge). */
export const fine = (collection: string, field: string, value: string | number | boolean): Topic =>
  `${collection}/${field}=${String(value)}`;

/** The collection a topic belongs to (both coarse and fine). */
export const collectionOf = (topic: Topic): string => {
  const slash = topic.indexOf("/");
  return slash === -1 ? topic : topic.slice(0, slash);
};

/** The derivable set of every node in a registry, keyed by collection. */
export const derivableSets = (
  nodes: Node.NodeRegistry
): ReadonlyMap<string, ReadonlySet<string>> => {
  const map = new Map<string, ReadonlySet<string>>();
  for (const [type, node] of nodes.nodes) {
    const fields = new Set<string>(node.hintKeys);
    for (const edge of Object.values(node.edges)) {
      if (edge.kind === "one") fields.add(edge.via);
    }
    map.set(type, fields);
  }
  return map;
};

const isLiteral = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The equality conjuncts of a predicate (a bare Compare or an And of them). */
const eqConjuncts = (
  predicate: Predicate.Predicate
): ReadonlyArray<{ readonly field: string; readonly value: string | number | boolean }> => {
  if (predicate._tag === "Compare" && predicate.op === "eq" && isLiteral(predicate.value)) {
    return [{ field: predicate.field, value: predicate.value }];
  }
  if (predicate._tag === "And") return predicate.predicates.flatMap(eqConjuncts);
  return [];
};

/**
 * The finest topic a window's predicate legally allows: an equality
 * conjunct on a derivable field → that fine topic (every row in the
 * window carries the value, so every affecting write derives it);
 * anything else → the coarse topic.
 */
export const topicForSubset = (
  subset: Subset.Subset,
  derivable: ReadonlySet<string> | undefined
): Topic => {
  if (derivable !== undefined) {
    for (const conjunct of eqConjuncts(subset.where)) {
      if (derivable.has(conjunct.field)) {
        return fine(subset.collection, conjunct.field, conjunct.value);
      }
    }
  }
  return coarse(subset.collection);
};

/**
 * The topics one written row derives: the coarse topic plus a fine topic
 * per derivable field of its **old and new** values — an update that moves
 * a row between parents pokes both edge windows; a delete derives from the
 * old row; a value-less write degrades to coarse alone.
 */
export const topicsForWrite = (
  collection: string,
  derivable: ReadonlySet<string> | undefined,
  values: { readonly oldValue?: unknown; readonly newValue?: unknown }
): ReadonlySet<Topic> => {
  const topics = new Set<Topic>([coarse(collection)]);
  if (derivable === undefined) return topics;
  for (const value of [values.oldValue, values.newValue]) {
    if (typeof value !== "object" || value === null) continue;
    for (const field of derivable) {
      const fieldValue = (value as Record<string, unknown>)[field];
      if (isLiteral(fieldValue)) topics.add(fine(collection, field, fieldValue));
    }
  }
  return topics;
};
