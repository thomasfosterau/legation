/**
 * NoEdges
 *
 * The edges of a node declared without any: the default of `Node.make`'s
 * `Edges` type parameter. This module is private. `effect/avoid-object-type`
 * is off for this module alone, in the root `vite.config.ts`.
 */

/**
 * No edges: the empty object type, the only object type whose `keyof` is
 * `never`. `Record<string, never>` would make `keyof Edges` `string` for every
 * node declared without edges. `Record<never, Edge>` resolves to this same
 * `{}`, so it would silence the rule without changing the type. The hazard
 * the rule names (`{}` admits any non-nullish value, `42` included) cannot
 * arise here: `Node.make` bounds `Edges` by `Record<string, Edge.Edge>`.
 */
export type NoEdges = {};
