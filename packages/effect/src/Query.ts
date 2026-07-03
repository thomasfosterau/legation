/**
 * Query
 *
 * THE read concept (ADR-0022). A query declares what to read — a node
 * collection, a `where`, `include`d edges (with per-edge windows), an
 * `order`, and cursor pagination — and compiles to a **plan** of sync
 * windows the engine tracks; `Subset`/`Predicate` are the plan's internal
 * representation.
 *
 * ```ts
 * Query.make({
 *   collection: "products",
 *   where: { categoryId: "c-audio" },
 *   include: { variants: true, reviews: { first: 10 } },
 *   order: ["name"],
 *   first: 20,
 * });
 * ```
 *
 * **Named queries are the same concept with a name and an args schema**
 * (`Query.named`): defined once and resolved twice — the client resolves
 * args to the plan it renders locally; the server resolves the same args to
 * the *authoritative* window it syncs, with the request's identity in hand
 * (ADR-0009's "what only the app can know").
 *
 * A paginated edge's `first` is a true sync window (ADR-0024): plan
 * execution registers one windowed subset per parent row, so the replica
 * syncs the window — not the dependent collection — and the same
 * `(order, first)` is re-applied to the resolved join locally (the replica
 * is normalized and may hold rows beyond one parent's window).
 */

import { Context, Effect, Schema, Stream } from "effect";
import type { SyncContext } from "./Backend.js";
import type * as ClientView from "./ClientView.js";
import { AuthorizationError, DuplicateNameError, QueryError } from "./Errors.js";
import type * as Node from "./Node.js";
import * as Predicate from "./Predicate.js";
import * as Related from "./Related.js";
import * as Subset from "./Subset.js";

/** A named query definition: the shared, serializable contract (name + args). */
export interface Named<Name extends string, Args, ArgsEncoded = unknown> {
  readonly name: Name;
  readonly args: Schema.Codec<Args, ArgsEncoded>;
}

/** @deprecated The named-definition type is {@link Named}. */
export type Query<Name extends string, Args, ArgsEncoded = unknown> = Named<
  Name,
  Args,
  ArgsEncoded
>;

export type AnyQuery = Named<string, any, any>;

/** Define a named query contract (the same concept as {@link Read}, with a name). */
export const named = <const Name extends string, Args, ArgsEncoded>(
  name: Name,
  args: Schema.Codec<Args, ArgsEncoded>
): Named<Name, Args, ArgsEncoded> => ({ name, args });

// ─── The declarative read ────────────────────────────────────────────────────

/** Options for one `include`d edge. `first` windows the edge's rows. */
export interface IncludeOptions {
  readonly first?: number;
}

/**
 * A declarative read: what to read, shaped like the data. `where` is an
 * equality map over row fields (a full `Predicate` is the escape hatch);
 * `include` names edges on the node; `order` tokens are field names,
 * `-` prefixed for descending; `first`/`after` page the root window.
 */
export interface Read {
  readonly collection: string;
  readonly where?: Readonly<Record<string, Predicate.Literal>> | Predicate.Predicate;
  readonly include?: Readonly<Record<string, true | IncludeOptions>>;
  readonly order?: ReadonlyArray<string>;
  readonly first?: number;
  readonly after?: string;
}

/** Define a read ({@link Read}), or a named contract via `(name, args)`. */
export function make(read: Read): Read;
export function make<const Name extends string, Args, ArgsEncoded>(
  name: Name,
  args: Schema.Codec<Args, ArgsEncoded>
): Named<Name, Args, ArgsEncoded>;
export function make(
  first: Read | string,
  args?: Schema.Codec<any, any>
): Read | Named<string, any, any> {
  return typeof first === "string" ? named(first, args!) : first;
}

/** Parse `order` tokens ("name", "-createdAt") into sort terms. */
const orderBy = Subset.parseOrder;

/**
 * A plan's edge selections for the relational read: paginated edges carry
 * their window (`first`), so each parent registers its own windowed subset
 * (ADR-0024); other kinds select unwindowed.
 */
const edgeSelects = (compiled: Plan): ReadonlyArray<Related.EdgeSelect> =>
  compiled.edges.map((edge) => ({
    name: edge.edge,
    ...(edge.kind === "paginated" && edge.first !== undefined ? { first: edge.first } : {}),
  }));

/** Compile a `where` to the plan's predicate representation. */
const compileWhere = (where: Read["where"]): Predicate.Predicate => {
  if (where === undefined) return Predicate.always;
  if ("_tag" in where) return where as Predicate.Predicate;
  const terms = Object.entries(where).map(([field, value]) =>
    Predicate.eq(field, value as Predicate.Literal)
  );
  return terms.length === 1 ? terms[0]! : Predicate.and(...terms);
};

/** One included edge, compiled: how to join and how to window the result. */
export interface EdgePlan {
  readonly edge: string;
  readonly kind: "one" | "many" | "paginated";
  readonly target: string;
  /** The edge's window: a per-parent sync window for paginated edges (ADR-0024). */
  readonly first?: number;
  /** The edge's declared order (paginated edges own their order). */
  readonly order: ReadonlyArray<Subset.OrderBy>;
}

/** A compiled read: the root sync window plus its edge plans. */
export interface Plan {
  readonly root: Subset.Subset;
  readonly edges: ReadonlyArray<EdgePlan>;
}

/**
 * Compile a read against the node graph: the root window as a `Subset`,
 * each `include`d edge resolved through the registry (its kind, target,
 * declared order) plus the read's per-edge window.
 */
export const plan = (nodes: Node.NodeRegistry, read: Read): Plan => {
  const root = Subset.make({
    collection: read.collection,
    where: compileWhere(read.where),
    orderBy: orderBy(read.order),
    ...(read.first === undefined ? {} : { limit: read.first }),
    ...(read.after === undefined ? {} : { cursor: read.after }),
  });
  const node = nodes.nodes.get(read.collection);
  const edges: Array<EdgePlan> = [];
  for (const [name, options] of Object.entries(read.include ?? {})) {
    if (node === undefined) {
      throw new QueryError({
        message: `Unknown collection for include: ${read.collection}`,
        query: read.collection,
      });
    }
    const edge = node.edges[name];
    if (edge === undefined) {
      throw new QueryError({
        message: `Unknown edge "${name}" on ${read.collection}`,
        query: read.collection,
      });
    }
    const window = options === true ? {} : options;
    edges.push({
      edge: name,
      kind: edge.kind,
      target: edge.target,
      ...(window.first === undefined ? {} : { first: window.first }),
      order: edge.kind === "paginated" ? orderBy(edge.order) : [],
    });
  }
  return { root, edges };
};

/** Order + window one edge's resolved rows (the client-side edge window). */
const applyEdgeWindow = (
  values: ReadonlyArray<unknown>,
  edgePlan: EdgePlan
): ReadonlyArray<unknown> => {
  let rows = values;
  if (edgePlan.order.length > 0) {
    rows = [...rows].sort((a, b) => {
      for (const term of edgePlan.order) {
        const left = (a as Record<string, unknown>)[term.field] as string | number;
        const right = (b as Record<string, unknown>)[term.field] as string | number;
        if (left === right) continue;
        const ordered = left < right ? -1 : 1;
        return term.direction === "asc" ? ordered : -ordered;
      }
      return 0;
    });
  }
  return edgePlan.first === undefined ? rows : rows.slice(0, edgePlan.first);
};

/** Apply a plan's edge windows to resolved rows (used by `Client`). */
export const applyWindows = (
  compiled: Plan,
  rows: ReadonlyArray<Related.RelatedRow>
): ReadonlyArray<Related.RelatedRow> => rows.map((row) => windowRow(row, compiled.edges));

/** Apply every collection-valued edge window to one resolved row. */
const windowRow = (row: Related.RelatedRow, edges: ReadonlyArray<EdgePlan>): Related.RelatedRow => {
  let related = row.related;
  for (const edgePlan of edges) {
    const value = related[edgePlan.edge];
    if (!Array.isArray(value)) continue;
    if (edgePlan.first === undefined && edgePlan.order.length === 0) continue;
    related = { ...related, [edgePlan.edge]: applyEdgeWindow(value, edgePlan) };
  }
  return related === row.related ? row : { ...row, related };
};

/**
 * Run a read once over the local view: the root window's rows, with every
 * `include`d edge resolved (and windowed) onto each row.
 */
export const run = (
  view: ClientView.Reader,
  nodes: Node.NodeRegistry,
  read: Read
): Effect.Effect<ReadonlyArray<Related.RelatedRow>, never> => {
  const compiled = plan(nodes, read);
  if (compiled.edges.length === 0) {
    return view.query(compiled.root).pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => ({ ...row, related: {} })))
    );
  }
  return Related.query(
    view,
    nodes.collections,
    read.collection,
    compiled.root,
    edgeSelects(compiled)
  ).pipe(Effect.map((rows) => rows.map((row) => windowRow(row, compiled.edges))));
};

/**
 * Observe a read over the local view: emits current rows now and re-emits
 * as the root window or any included edge's rows change.
 */
export const observe = (
  view: ClientView.Reader,
  nodes: Node.NodeRegistry,
  read: Read
): Stream.Stream<ReadonlyArray<Related.RelatedRow>, never> => {
  const compiled = plan(nodes, read);
  if (compiled.edges.length === 0) {
    return view.observe(compiled.root).pipe(
      Stream.orDie,
      Stream.map((rows) => rows.map((row) => ({ ...row, related: {} })))
    );
  }
  return Related.observe(
    view,
    nodes.collections,
    read.collection,
    compiled.root,
    edgeSelects(compiled)
  ).pipe(Stream.map((rows) => rows.map((row) => windowRow(row, compiled.edges))));
};

// ─── Client side ─────────────────────────────────────────────────────────────

/** Resolve a query's args to the subset the client renders locally. */
export type LocalQuery<Args> = (args: Args) => Subset.Subset;

/** Query definitions paired with their client-side subset factories. */
export interface QueryRegistry {
  readonly queries: ReadonlyMap<string, AnyQuery>;
  readonly locals: ReadonlyMap<string, LocalQuery<any>>;
}

/** Pair query definitions with client subset factories. Duplicate names throw. */
export const registry = (
  entries: ReadonlyArray<{ readonly query: AnyQuery; readonly local: LocalQuery<any> }>
): QueryRegistry => {
  const queries = new Map<string, AnyQuery>();
  const locals = new Map<string, LocalQuery<any>>();
  for (const { query, local } of entries) {
    if (queries.has(query.name)) throw new DuplicateNameError({ kind: "query", name: query.name });
    queries.set(query.name, query);
    locals.set(query.name, local);
  }
  return { queries, locals };
};

// ─── Server side ─────────────────────────────────────────────────────────────

/** Resolve a query's args + request identity to the authoritative subset. */
export type ServerQuery<Args> = (
  args: Args,
  context: SyncContext
) => Effect.Effect<Subset.Subset, AuthorizationError>;

/** Resolve a named subscription (name + encoded args) to a server subset. */
export interface QueryResolver {
  readonly resolve: (
    name: string,
    encodedArgs: unknown,
    context: SyncContext
  ) => Effect.Effect<Subset.Subset, AuthorizationError | QueryError>;
}

export const QueryResolver = Context.Service<QueryResolver>("@legation/effect/QueryResolver");

/**
 * Build a server resolver from typed entries. Pushed args are untrusted, so
 * each is schema-validated before the server query runs; an unknown name is
 * denied (a `QueryError`).
 */
export const resolver = (
  entries: ReadonlyArray<{ readonly query: AnyQuery; readonly server: ServerQuery<any> }>
): QueryResolver => {
  const map = new Map(entries.map((entry) => [entry.query.name, entry] as const));
  return {
    resolve: (name, encodedArgs, context) => {
      const entry = map.get(name);
      if (entry === undefined) {
        return Effect.fail(new QueryError({ message: `Unknown query: ${name}`, query: name }));
      }
      return Schema.decodeUnknownEffect(entry.query.args)(encodedArgs).pipe(
        Effect.mapError(
          (cause) =>
            new QueryError({ message: `Invalid args for query "${name}"`, query: name, cause })
        ),
        Effect.flatMap((args) => entry.server(args, context))
      );
    },
  };
};
