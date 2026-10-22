/**
 * NodeBridge
 *
 * The first-class integration ADR-0022 promised: a JSON:API resource
 * definition (`Resource.make` from `@thomasfosterau/effect-jsonapi`) **is**
 * a node definition — same type name, same attributes, and relationships
 * that map one-for-one onto edges. This module derives {@link Node} graphs
 * from resource definitions so an app declares its resources once and gets
 * the sync engine's replica, queries, joins, and fan-out topics from the
 * same source of truth as its HTTP API.
 *
 * The mapping:
 *
 * - `Relationship.one` / `Relationship.optional` → `Edge.one`, stored in
 *   the foreign-key field `` `${name}Id` `` (override per relationship with
 *   `via`). JSON:API keeps relationship linkage out of `attributes`, so the
 *   engine-side row gains the key field the edge declares.
 * - `Relationship.many` / `Relationship.paginated` → `Edge.many` /
 *   `Edge.paginated`. The **inverse** — the one-edge on the target holding
 *   the key — is discovered when it is unambiguous, and named explicitly
 *   (`inverses`) when it is not.
 * - `paginated` edges need an `order` (cursor pagination requires a stable
 *   order, and it is part of the edge's identity — ADR-0022), so it must
 *   be declared in the bridge options.
 *
 * **Acyclic resource graphs.** The library's resource types expand eagerly,
 * so mutually-referencing definitions (`Product ⇄ Review`) cannot be
 * authored; the idiomatic JSON:API graph points parent → child and the
 * child carries its foreign key as a plain attribute (`productId`). The
 * `edges` option closes that gap: it promotes such an attribute to a
 * declared one-edge on the bridged node, and {@link registry} discovers
 * collection-valued inverses across **bridged** one-edges — declared and
 * relationship-derived alike — so the acyclic graph bridges without ever
 * naming an inverse by hand.
 *
 * **The filterable set** (ADR-0028 rule d, #154) is read off the resource's
 * own declaration (effect-jsonapi, since 0.13: `Filter.able` / `Sort.able` piped
 * onto an attribute schema, `Resource.attribute(schema, { filter, sort })`,
 * `Relationship.one(ref, { filter })`) through `Resource.filterable` /
 * `Resource.sortable`. An attribute keeps its name and derives its literal
 * kind from its schema exactly as `Node.make` does; a to-one relationship's
 * declaration lands on the edge's **key field** (`author` → `authorId`,
 * kind `text`), which is the field the engine filters by. The
 * `filterable` / `sortable` options remain as overrides: an option entry
 * replaces the resource's declaration for that field (the way to give an
 * `instant` its kind, which no schema can tell), and adds fields the
 * resource does not declare.
 *
 * All mismatches are definition-time defects (a thrown
 * {@link ResourceBridgeError}), never runtime failures: a resource graph
 * either bridges completely or not at all.
 *
 * **Identity** is always `id` here: a JSON:API resource is identified by the
 * spec's `id` member, so a bridged node declares no identity attribute of its
 * own (`Node.make`'s `id` option, #144). The JSON:API surface — `/{type}/{id}`
 * widening to `filter[id]`, linkage and `included` reading `id` off a row
 * value — assumes that, so a hand-built node naming a natural key is not yet
 * servable through these handlers.
 */

import { Resource } from "@thomasfosterau/effect-jsonapi";
import { Edge, type FilterPolicy, Node } from "@thomasfosterau/legation-effect";
import * as Data from "effect/Data";
import type * as Schema from "effect/Schema";

/** A definition-time mismatch between a resource graph and the node model. */
export class ResourceBridgeError extends Data.TaggedError("ResourceBridgeError")<{
  readonly resource: string;
  readonly relationship: string;
  readonly message: string;
}> {}

/** Per-resource overrides for {@link fromResource} / {@link registry}. */
export interface FromResourceOptions {
  /**
   * The foreign-key field a `one`/`optional` relationship's edge stores its
   * id in, by relationship name. Defaults to `` `${name}Id` ``.
   */
  readonly via?: Record<string, string>;
  /**
   * One-edges beyond the resource's relationships, by edge name — promote
   * a foreign-key **attribute** to an edge when the resource graph is
   * acyclic and could not declare the relationship itself (see the module
   * doc). The attribute named by `via` moves out of the node's attributes;
   * the edge's key field replaces it.
   */
  readonly edges?: Record<string, { readonly target: string; readonly via: string }>;
  /**
   * The inverse edge name on the target, by relationship name — required
   * only when discovery is ambiguous (the target has several one-edges
   * back) or impossible (it has none).
   */
  readonly inverses?: Record<string, string>;
  /**
   * The edge order for `paginated` relationships, by relationship name
   * (field names, `-` prefixed for descending). Required for every
   * `paginated` relationship — order is part of the edge's identity.
   */
  readonly order?: Record<string, ReadonlyArray<string>>;
  /** Passed through to the node (fine fan-out topics — ADR-0023). */
  readonly hintKeys?: ReadonlyArray<string>;
  /**
   * Overrides and additions to the resource's own filterable declaration
   * (ADR-0028, #154; see the module doc), by row field: the operators
   * alone (the literal kind is derived from the attribute schema), or
   * `{ operators, kind }` where the schema cannot tell the kind (an
   * `instant` stored as text). An entry replaces the resource's declaration
   * for that field. `id` and every bridged one-edge's key field are
   * filterable by `eq` / `in` regardless.
   */
  readonly filterable?: Record<string, FilterPolicy.FilterableInput>;
  /** Sortable fields beyond the resource's `Sort.able` declaration; `id` is always sortable. */
  readonly sortable?: ReadonlyArray<string>;
}

const fail = (resource: string, relationship: string, message: string): never => {
  throw new ResourceBridgeError({ resource, relationship, message });
};

/**
 * The one-edges a resource bridges to: its `one`/`optional` relationships
 * plus the option-declared extras. This is the map inverse discovery
 * scans, so declared and relationship-derived edges resolve identically.
 */
const oneEdgesOf = (
  resource: Resource.Any,
  options: FromResourceOptions
): Record<string, Edge.One> => {
  const edges: Record<string, Edge.One> = {};
  for (const [name, descriptor] of Object.entries(resource.relationships)) {
    if (descriptor.kind === "one" || descriptor.kind === "optional") {
      edges[name] = Edge.one(descriptor.ref().type, {
        via: options.via?.[name] ?? `${name}Id`,
      });
    }
  }
  for (const [name, declared] of Object.entries(options.edges ?? {})) {
    edges[name] = Edge.one(declared.target, { via: declared.via });
  }
  return edges;
};

/**
 * Discover the inverse of a collection-valued relationship: the unique
 * one-edge on the (bridged) target that points back at `source`.
 */
const discoverInverse = (
  source: string,
  name: string,
  target: string,
  targetOneEdges: Record<string, Edge.One>
): string => {
  const candidates = Object.entries(targetOneEdges).filter(([, edge]) => edge.target === source);
  if (candidates.length === 1) return candidates[0]![0];
  return fail(
    source,
    name,
    candidates.length === 0
      ? `no inverse found: "${target}" bridges no one-edge back to "${source}" — declare one (a relationship, or options.edges over its key attribute), or name it in options.inverses`
      : `ambiguous inverse: "${target}" bridges ${candidates.length} one-edges back to "${source}" (${candidates
          .map(([candidate]) => `"${candidate}"`)
          .join(", ")}) — name the right one in options.inverses`
  );
};

/** A `many` / `paginated` relationship's descriptor, as the bridge reads it. */
type CollectionRelationship = Extract<
  Resource.Any["relationships"][string],
  { readonly kind: "many" | "paginated" }
>;

/**
 * Bridge one collection-valued relationship to its edge: the inverse is
 * named in the options or discovered on the target; a paginated one also
 * needs its declared order.
 */
const collectionEdge = (
  resource: Resource.Any,
  name: string,
  descriptor: CollectionRelationship,
  options: FromResourceOptions,
  oneEdgesOfTarget: (target: Resource.Any) => Record<string, Edge.One>
): Edge.Edge => {
  const target = descriptor.ref();
  const inverse =
    options.inverses?.[name] ??
    discoverInverse(resource.type, name, target.type, oneEdgesOfTarget(target));
  if (descriptor.kind === "many") return Edge.many(target.type, { inverse });
  const order = options.order?.[name];
  if (order === undefined) {
    return fail(
      resource.type,
      name,
      `a paginated relationship needs an edge order (cursor pagination requires a stable order) — declare it in options.order`
    );
  }
  return Edge.paginated(target.type, { inverse, order });
};

/** The resource's edges: its one-edges plus every collection-valued relationship's. */
const edgesOf = (
  resource: Resource.Any,
  options: FromResourceOptions,
  oneEdgesOfTarget: (target: Resource.Any) => Record<string, Edge.One>
): Record<string, Edge.Edge> => {
  const edges: Record<string, Edge.Edge> = { ...oneEdgesOf(resource, options) };
  for (const [name, descriptor] of Object.entries(resource.relationships)) {
    if (descriptor.kind !== "many" && descriptor.kind !== "paginated") continue;
    edges[name] = collectionEdge(resource, name, descriptor, options, oneEdgesOfTarget);
  }
  return edges;
};

/**
 * The resource's attributes minus every one-edge's key field: a one-edge's
 * key replaces any attribute of the same name (the promoted-attribute
 * case); the edge's branded id carries the field.
 */
const attributesOf = (
  resource: Resource.Any,
  edges: Record<string, Edge.Edge>
): Schema.Struct.Fields => {
  const attributes: Record<string, Schema.Constraint> = { ...resource.fields.attributes.fields };
  for (const edge of Object.values(edges)) {
    if (edge.kind === "one") delete attributes[edge.via];
  }
  return attributes;
};

/** One entry of `Resource.filterable`, as the bridge reads it. */
interface DeclaredField {
  readonly operators: ReadonlyArray<FilterPolicy.FilterOperator>;
}

/**
 * The filterable set the resource declares, keyed by **row field**: an
 * attribute under its own name, with the kind left to `Node.make` to derive
 * from its schema; a to-one relationship under its edge's key field, kind
 * `text` (an id). A key field declared twice — the relationship and the
 * attribute it is stored in both filterable — is a definition-time defect:
 * neither declaration may silently win.
 */
const declaredFilterable = (
  resource: Resource.Any,
  edges: Record<string, Edge.Edge>
): Record<string, FilterPolicy.FilterableInput> => {
  const declared: Record<string, FilterPolicy.FilterableInput> = {};
  const attributes = resource.fields.attributes.fields;
  const entries = Object.entries(Resource.filterable(resource)) as Array<[string, DeclaredField]>;
  for (const [key, entry] of entries) {
    const edge = edges[key];
    const viaRelationship = attributes[key] === undefined && edge?.kind === "one";
    const field = viaRelationship ? edge.via : key;
    if (declared[field] !== undefined) {
      fail(
        resource.type,
        key,
        `key field "${field}" is declared filterable twice (by relationship "${key}" and by the attribute it is stored in) — declare it once`
      );
    }
    declared[field] = viaRelationship
      ? { operators: entry.operators, kind: "text" }
      : entry.operators;
  }
  return declared;
};

/**
 * The per-node options: hint keys from the bridge options; the filterable
 * set and sortable fields from the resource's declaration, each option
 * entry replacing the resource's for its field.
 */
const nodeOptionsOf = (
  resource: Resource.Any,
  edges: Record<string, Edge.Edge>,
  options: FromResourceOptions
): {
  readonly hintKeys?: ReadonlyArray<string>;
  readonly filterable: Record<string, FilterPolicy.FilterableInput>;
  readonly sortable: ReadonlyArray<string>;
} => ({
  ...(options.hintKeys === undefined ? {} : { hintKeys: options.hintKeys }),
  filterable: { ...declaredFilterable(resource, edges), ...options.filterable },
  sortable: [...Resource.sortable(resource), ...(options.sortable ?? [])],
});

/** Bridge one resource, resolving inverses through `oneEdgesOfTarget`. */
const bridge = (
  resource: Resource.Any,
  options: FromResourceOptions,
  oneEdgesOfTarget: (target: Resource.Any) => Record<string, Edge.One>
): Node.AnyNode => {
  const edges = edgesOf(resource, options, oneEdgesOfTarget);
  return Node.make(resource.type, {
    attributes: attributesOf(resource, edges),
    edges,
    ...nodeOptionsOf(resource, edges, options),
  });
};

/**
 * Derive a {@link Node} definition from a single JSON:API resource
 * definition. Inverse discovery here sees only the target resource's own
 * relationships — bridge a whole graph with {@link registry} to discover
 * across option-declared edges too.
 */
export const fromResource = (
  resource: Resource.Any,
  options: FromResourceOptions = {}
): Node.AnyNode => bridge(resource, options, (target) => oneEdgesOf(target, {}));

/**
 * Bridge a whole resource graph and close it as a validated
 * {@link Node.NodeRegistry} — nodes plus the derived engine
 * `CollectionRegistry`, ready for `Client.make` / `Server.make`.
 * Options are keyed by resource type.
 */
export const registry = (
  resources: ReadonlyArray<Resource.Any>,
  options: Record<string, FromResourceOptions> = {}
): Node.NodeRegistry =>
  Node.registry(
    resources.map((resource) =>
      bridge(resource, options[resource.type] ?? {}, (target) =>
        oneEdgesOf(target, options[target.type] ?? {})
      )
    )
  );
