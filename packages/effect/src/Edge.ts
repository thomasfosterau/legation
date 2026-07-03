/**
 * Edge
 *
 * A node's relationship to other nodes (ADR-0022): `one`, `many`, or
 * `paginated`. An edge is a **view over one foreign key, never storage** —
 * a collection-valued edge from `products` to `reviews` IS the dependent
 * collection `reviews where productId = <parent id>`. The key is declared
 * once, on the child (`Edge.one("products", { via: "productId" })`); the
 * parent's collection-valued edge names the **inverse** rather than
 * restating the mapping, so the two directions cannot drift.
 *
 * Targets are referenced **by name** and closed through the node registry
 * (`Node.registry`), so mutually-referencing definitions carry no
 * type-level cycle.
 *
 * The same key powers the join (`Related`), the sync window (an equality
 * subset), the auth scope (ADR-0015), and the fan-out topic (ADR-0023's
 * derivable set).
 */

/** A reference to a single foreign node, held as a foreign-key field. */
export interface One<Target extends string = string, Via extends string = string> {
  readonly kind: "one";
  readonly target: Target;
  /** The field on THIS node's rows holding the foreign id. */
  readonly via: Via;
}

/** The dependent collection of target nodes whose inverse edge points here. */
export interface Many<Target extends string = string> {
  readonly kind: "many";
  readonly target: Target;
  /** The name of the `one` edge on the target that holds the key. */
  readonly inverse: string;
}

/**
 * Like {@link Many}, but windowed: consumers page through it with cursors,
 * and each `(parent, edge, window)` is its own sync unit (ADR-0022).
 * `order` is part of the edge's identity — connection cursors need a
 * stable order, so it is not a per-query choice. Tokens are field names,
 * `-` prefixed for descending (`"-createdAt"`).
 */
export interface Paginated<Target extends string = string> {
  readonly kind: "paginated";
  readonly target: Target;
  /** The name of the `one` edge on the target that holds the key. */
  readonly inverse: string;
  readonly order: ReadonlyArray<string>;
}

export type Edge = One | Many | Paginated;

/** Declare a reference to a single `target` node, stored in field `via`. */
export const one = <const Target extends string, const Via extends string>(
  target: Target,
  options: { readonly via: Via }
): One<Target, Via> => ({ kind: "one", target, via: options.via });

/** Declare the dependent collection of `target` nodes (unbounded). */
export const many = <const Target extends string>(
  target: Target,
  options: { readonly inverse: string }
): Many<Target> => ({ kind: "many", target, inverse: options.inverse });

/** Declare the dependent collection of `target` nodes, paged by cursor. */
export const paginated = <const Target extends string>(
  target: Target,
  options: { readonly inverse: string; readonly order: ReadonlyArray<string> }
): Paginated<Target> => ({
  kind: "paginated",
  target,
  inverse: options.inverse,
  order: options.order,
});
