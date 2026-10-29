/**
 * JsonApiQuery
 *
 * The bridge between the filter grammar's URL form and the engine's plan
 * (ADR-0028 §5, issue #161) — a façade-boundary projection for one job
 * (ADR-0029 §6: a URL must mean the same thing answered from the replica as
 * answered by the network), not a general translation between two dialects
 * of one language. effect-jsonapi owns the grammar — its AST (`Filter.Ast`),
 * the `filter[...]` ⇄ AST codec (`Query.Filter`), the whole query codec
 * (`Query.schema`) and the canonical query string (`Query.canonical`); this
 * module owns the three translations legation needs on top of them:
 *
 * - **Filter AST ⇄ `Predicate`** ({@link fromFilterAst}, {@link toFilterAst}):
 *   both directions are partial, and neither is the other's inverse.
 *   {@link fromFilterAst} rejects a literal that is not a wire scalar
 *   (`string | number | boolean`) or a `Date` (encoded to its instant text —
 *   see below) with a typed `QueryError`, since a grammar AST is typed by
 *   the attribute's **decoded** schema and that type is open-ended (issue
 *   #218's design note). {@link toFilterAst} returns `None` for `Exists`
 *   (server-only, no URL form), an empty `In` / `NotIn` list, and a `null`
 *   literal (the grammar's lists are non-empty and `NULL` is never a
 *   literal — `isnull` names it); those callers fail closed.
 *   {@link foldConstants} removes the two definite cases before encoding:
 *   an empty `In` is false and an empty `NotIn` is true under ADR-0028's
 *   per-operator table, so they fold away exactly. Both functions carry a
 *   **field-namespace precondition**: a field name is copied verbatim
 *   between the two ASTs, which is correct only because every caller in
 *   this module pre-synthesises a resource whose field names are already
 *   the engine's ({@link resourcesOf} — a to-one edge is named by its FK key
 *   field, never the relationship name). Neither function checks that a
 *   field it is given actually names something on the other side; a caller
 *   bridging an AST built over a resource with its own naming must
 *   translate field names first. A `Date` literal's conversion to
 *   `value.toISOString()` is an **encode, not a copy**: ADR-0028 rule (e)
 *   fixes instant comparison to that exact text, so an instant literal that
 *   arrives any other way (a differently-formatted string, say) will not
 *   compare correctly downstream — this is the one step in either direction
 *   that changes a value's representation rather than re-tagging it, which
 *   is also why {@link toFilterAst} is a separate partial function rather
 *   than {@link fromFilterAst}'s inverse: the type erasure `Date → string`
 *   cannot be undone from the `Predicate` side alone.
 * - **URL → `Query.Read`** ({@link parseRead}, {@link parseParams}): a
 *   request URL is decoded with effect-jsonapi's `Query.schema` for the
 *   collection's node — `include`, `fields`, `sort`, `page` and `filter` —
 *   and mapped onto the declarative read: `filter` → `where`, `sort` →
 *   `order`, `page[limit]` / `page[after]` → `first` / `after`, `include`
 *   → the edge selects. `fields[]` is a serialisation-time projection
 *   (ADR-0029 §5) and is carried beside the read, never into the plan.
 *   Every rejection is a `QueryError` naming the parameter, so a façade or
 *   a derived REST handler answers 400 with `source.parameter` set.
 * - **`Query.Read` → canonical string** ({@link canonical}): the read is
 *   compiled with `Query.plan` and its plan is encoded through the
 *   canonical encoder, so two reads with one plan have one string —
 *   subscription identity for `Client.subscribe(url)` (ADR-0029 §2).
 *   {@link urlReads} packages the parse and the canonical string as the
 *   `Client.UrlReads` seam a Client or an engine host is built with (#159).
 *
 * The query codec is derived from the **node graph**, not from an
 * effect-jsonapi resource: {@link resourcesOf} synthesises one resource per
 * node whose filterable attributes carry the node's filterable set (the
 * operators and literal kinds of ADR-0028 rule d, #154) and whose
 * relationships are the node's edges. A filter names the row field the
 * engine evaluates — a `one`-edge is filtered by its key field
 * (`filter[categoryId]=c-audio`, as in ADR-0029's worked examples), not by
 * the edge name. Include paths are single level (decision D1 of ADR-0028):
 * a read includes a node's own edges only, so `include=variants.product` is
 * rejected as a parse failure.
 *
 * The **exact encoder** ({@link defaultEncoder}) is what `JsonApiBackend`
 * pushes to the server: the whole predicate as the grammar's canonical
 * `filter[...]` record (operators, `or`, `not`, `isnull` and `nin`
 * included — nothing is dropped any more), plus `sort`. Order, cursor and
 * limit stay local: `Subset.apply` still finalises the window, which is now
 * redundancy over an exact filter rather than correction of a superset
 * (ADR-0028 §6). A predicate that can never match (an empty allow-set)
 * encodes to `None` and the backend skips the request.
 */

import { Filter, Query as UrlQuery, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Str from "effect/String";
import {
  type Client,
  FilterPolicy,
  type Node,
  Predicate,
  Query,
  QueryError,
} from "@thomasfosterau/legation-effect";
import type { Subset } from "@thomasfosterau/legation-effect/internal";
import type { JsonApiRequestOptions, SortTerm } from "./types.js";

// ─── Filter AST ⇄ Predicate ──────────────────────────────────────────────────

/**
 * A grammar literal as a `Predicate` literal: scalars as they are, a `Date`
 * as its instant text (the load-bearing encode of ADR-0028 rule e), or a
 * typed `QueryError` for anything else — a grammar AST is typed by the
 * attribute's decoded schema (issue #218's design note), which is
 * open-ended, so this is the one place that type meets `Predicate.Literal`'s
 * closed wire-scalar union and can fail.
 */
const literalOf = (field: string, value: unknown): Result.Result<Predicate.Literal, QueryError> => {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return Result.succeed(value);
    default:
      return value instanceof Date
        ? Result.succeed(value.toISOString())
        : Result.fail(
            new QueryError({
              message: `Filter literal ${JSON.stringify(value)} for field "${field}" is not a scalar`,
              parameter: `filter[${field}]`,
            })
          );
  }
};

/**
 * The engine form of a filter AST, or a typed `QueryError` naming the field
 * whose literal {@link literalOf} rejects: `Compare` / `In` / `NotIn` /
 * `IsNull` map node for node, `And` / `Or` / `Not` recurse, and the empty
 * conjunction (the grammar's "true") is `Predicate.always`. The map is
 * structural — a singleton group, which the grammar's normal form keeps
 * after deduplicating `Or(x, x)`, stays a singleton group rather than
 * collapsing through `Predicate.or` — so {@link canonical} is idempotent.
 * Literals are the codec's decoded scalars; a `Date` (a `DateFromString`
 * attribute) becomes its ISO-8601 UTC text (see the module doc's encode
 * note). Field names are copied verbatim — the module doc's
 * field-namespace precondition.
 *
 * This module's own callers ({@link readOf}, {@link filterOf}) never see
 * this fail: their ASTs are decoded through {@link resourcesOf}'s synthetic
 * resource, whose filterable attributes admit only wire scalars, or are
 * built by {@link toFilterAst} from a `Predicate.Literal`, which is one
 * already. The typed failure exists for this function's public contract —
 * any caller bridging an AST built over a resource with a richer decoded
 * attribute type (a `Date`-valued one aside, which is handled) — not for
 * either call site here.
 */
export const fromFilterAst = (ast: Filter.Node): Result.Result<Predicate.Predicate, QueryError> => {
  switch (ast._tag) {
    case "Compare":
      return Result.map(literalOf(ast.field, ast.value), (value) =>
        Predicate.compare(ast.op, ast.field, value)
      );
    case "In":
      return Result.map(
        Result.all(ast.values.map((value) => literalOf(ast.field, value))),
        (values) => Predicate.isIn(ast.field, values)
      );
    case "NotIn":
      return Result.map(
        Result.all(ast.values.map((value) => literalOf(ast.field, value))),
        (values) => Predicate.notIn(ast.field, values)
      );
    case "IsNull":
      return Result.succeed(
        ast.negated ? Predicate.isNotNull(ast.field) : Predicate.isNull(ast.field)
      );
    case "And":
      return Arr.isReadonlyArrayEmpty(ast.members)
        ? Result.succeed(Predicate.always)
        : Result.map(
            Result.all(ast.members.map(fromFilterAst)),
            (predicates): Predicate.Predicate => ({ _tag: "And", predicates })
          );
    case "Or":
      return Result.map(
        Result.all(ast.members.map(fromFilterAst)),
        (predicates): Predicate.Predicate => ({ _tag: "Or", predicates })
      );
    case "Not":
      return Result.map(fromFilterAst(ast.member), Predicate.not);
  }
};

/** A non-empty list of non-null literals, or `None` (the grammar has neither an empty list nor a `NULL` literal). */
const literalList = (
  values: ReadonlyArray<Predicate.Literal>
): Option.Option<readonly [Predicate.Literal, ...Array<Predicate.Literal>]> => {
  const [head, ...tail] = values;
  return head === undefined || head === null || tail.includes(null)
    ? Option.none()
    : Option.some([head, ...(tail as Array<Predicate.Literal>)]);
};

/**
 * The grammar form of a predicate, or `None` where it has no URL form:
 * `Exists` (server-only, ADR-0028 §5), an empty `In` / `NotIn` list, or a
 * `null` literal (the deprecated wire form of `isnull`; it evaluates to
 * unknown and cannot be folded). `True` is the empty conjunction.
 * `fromFilterAst ∘ toFilterAst` is the identity on every constructor-built
 * predicate it accepts.
 */
export const toFilterAst = (predicate: Predicate.Predicate): Option.Option<Filter.Node> => {
  switch (predicate._tag) {
    case "True":
      return Option.some(Filter.and());
    case "Compare":
      return predicate.value === null
        ? Option.none()
        : Option.some({
            _tag: "Compare",
            op: predicate.op,
            field: predicate.field,
            value: predicate.value,
          } satisfies Filter.Compare);
    case "In":
      return Option.map(literalList(predicate.values), (values) =>
        Filter.isIn(predicate.field, values)
      );
    case "NotIn":
      return Option.map(literalList(predicate.values), (values) =>
        Filter.notIn(predicate.field, values)
      );
    case "IsNull":
      return Option.some(Filter.isNull(predicate.field, predicate.negated === true));
    case "And":
      return Option.map(Option.all(predicate.predicates.map(toFilterAst)), (members) =>
        Filter.and(...members)
      );
    case "Or":
      return Option.map(Option.all(predicate.predicates.map(toFilterAst)), (members) =>
        Filter.or(...members)
      );
    case "Not":
      return Option.map(toFilterAst(predicate.predicate), Filter.not);
    case "Exists":
    case "InSet":
      return Option.none();
  }
};

// ─── Constant folding ────────────────────────────────────────────────────────

/** The definite-false predicate: the empty disjunction (`Some(false)` for every row). */
const FALSE: Predicate.Predicate = { _tag: "Or", predicates: [] };

const isTrue = (predicate: Predicate.Predicate): boolean => predicate._tag === "True";
const isFalse = (predicate: Predicate.Predicate): boolean =>
  predicate._tag === "Or" && Arr.isReadonlyArrayEmpty(predicate.predicates);

/** Kleene `And` over folded members: any false is false; true members vanish. */
const foldAnd = (members: ReadonlyArray<Predicate.Predicate>): Predicate.Predicate => {
  const folded = members.map(foldConstants);
  if (folded.some(isFalse)) return FALSE;
  const kept = folded.filter((member) => !isTrue(member));
  return Arr.isReadonlyArrayEmpty(kept) ? Predicate.always : Predicate.and(...kept);
};

/** Kleene `Or` over folded members: any true is true; false members vanish. */
const foldOr = (members: ReadonlyArray<Predicate.Predicate>): Predicate.Predicate => {
  const folded = members.map(foldConstants);
  if (folded.some(isTrue)) return Predicate.always;
  const kept = folded.filter((member) => !isFalse(member));
  return Arr.isReadonlyArrayEmpty(kept) ? FALSE : Predicate.or(...kept);
};

const foldNot = (inner: Predicate.Predicate): Predicate.Predicate => {
  const folded = foldConstants(inner);
  return isTrue(folded) ? FALSE : isFalse(folded) ? Predicate.always : Predicate.not(folded);
};

/**
 * Fold the definite constants out of a predicate, exactly under ADR-0028's
 * three-valued semantics: an empty `In` is false and an empty `NotIn` is
 * true for every row (the compilers render them `1 = 0` / `1 = 1`), a
 * false conjunct or a true disjunct decides its connective, and true
 * conjuncts / false disjuncts vanish. Unknown is never folded — a `null`
 * literal stays where it is. The result is `Predicate.always`, the empty
 * `Or` (false), or a predicate free of empty lists.
 */
export const foldConstants = (predicate: Predicate.Predicate): Predicate.Predicate => {
  switch (predicate._tag) {
    case "In":
      return Arr.isReadonlyArrayEmpty(predicate.values) ? FALSE : predicate;
    case "NotIn":
      return Arr.isReadonlyArrayEmpty(predicate.values) ? Predicate.always : predicate;
    case "And":
      return foldAnd(predicate.predicates);
    case "Or":
      return foldOr(predicate.predicates);
    case "Not":
      return foldNot(predicate.predicate);
    default:
      return predicate;
  }
};

// ─── The node graph as a query declaration ───────────────────────────────────

/** A check that a decoded literal is a value of the kind (`FilterPolicy.matchesKind`). */
const kindCheck = (kind: FilterPolicy.LiteralKind) =>
  Schema.makeFilter<Predicate.Literal>((value) => FilterPolicy.matchesKind(kind, value), {
    identifier: `LiteralKind.${kind}`,
    title: kind,
    description: `a literal of kind "${kind}"`,
  });

/**
 * The attribute schema a filter literal of the kind decodes through: the
 * wire string is parsed as the scalar the schema's encoded form names, then
 * checked against the kind (int4 range, the fixed instant format).
 */
const literalSchema = (kind: FilterPolicy.LiteralKind): Schema.Top => {
  switch (kind) {
    case "text":
      return Schema.String;
    case "instant":
      return Schema.String.pipe(Schema.check(kindCheck("instant")));
    case "integer":
      return Schema.Number.pipe(Schema.check(kindCheck("integer")));
    case "double":
      return Schema.Number;
    case "boolean":
      return Schema.Boolean;
  }
};

/**
 * The synthetic resource's attributes: every filterable field (`id` and the
 * `one`-edge keys included) with its kind's schema and its operators
 * declared through `Filter.able`; every other attribute as `Unknown`, so
 * `fields[type]` still names it but no filter reaches it.
 */
const attributesOf = (node: Node.AnyNode): Record<string, Schema.Top> => {
  const filterable: Record<string, Schema.Top> = R.map(node.filterable, (declared) =>
    literalSchema(declared.kind).pipe(Filter.able(declared.operators))
  );
  // Declared filterable fields first, then the other attributes, untyped.
  return {
    ...filterable,
    ...R.map(
      R.filter(node.attributes, (_, field) => !R.has(filterable, field)),
      (): Schema.Top => Schema.Unknown
    ),
  };
};

/**
 * The synthetic resource's relationships: the node's edges, targets
 * resolved lazily through the graph. A paginated edge is a `many`
 * relationship here: effect-jsonapi keeps `Relationship.paginated` out of
 * `include` paths, whereas a read includes a paginated edge like any other
 * (its per-parent window is the plan's, not the URL's — {@link canonical}
 * refuses `include: { first }`).
 */
/**
 * The resource of node `type`. {@link resourcesOf} builds one per node and
 * every edge targets a node, so a miss is a defect, never a request error.
 */
const resourceIn = (resources: ReadonlyMap<string, Resource.Any>, type: string): Resource.Any => {
  const resource = resources.get(type);
  if (resource === undefined) throw new QueryError({ message: `No resource for node "${type}"` });
  return resource;
};

const relationshipsOf = (
  node: Node.AnyNode,
  resources: ReadonlyMap<string, Resource.Any>
): Record<string, Relationship.Descriptor> => {
  return R.map(node.edges, (edge): Relationship.Descriptor => {
    const target = () => resourceIn(resources, edge.target);
    return edge.kind === "one" ? Relationship.one(target) : Relationship.many(target);
  });
};

const resourceGraphs = new WeakMap<Node.NodeRegistry, ReadonlyMap<string, Resource.Any>>();

/**
 * The node graph as effect-jsonapi resource definitions, one per node —
 * the declaration the URL codecs are derived from. Attributes are typed by
 * the node's filterable set (kind and operators), relationships are its
 * edges; nothing else about the resource is faithful (a document is never
 * serialised through it). Memoised per registry.
 */
export const resourcesOf = (nodes: Node.NodeRegistry): ReadonlyMap<string, Resource.Any> => {
  const cached = resourceGraphs.get(nodes);
  if (cached !== undefined) return cached;
  const resources = new Map<string, Resource.Any>();
  nodes.nodes.forEach((node) =>
    resources.set(
      node.type,
      Resource.make(node.type, {
        attributes: attributesOf(node),
        relationships: relationshipsOf(node, resources),
      })
    )
  );
  resourceGraphs.set(nodes, resources);
  return resources;
};

/**
 * The root window's page parameters: `page[limit]` is the read's `first`
 * (a positive integer), `page[after]` its `after` cursor (a row id,
 * opaque on the wire), `page[offset]` its `offset` (a non-negative
 * integer, #209 — every audited app's pagination idiom). `page[offset]`
 * and `page[after]` are different pagination idioms; {@link parseParams}
 * rejects a request naming both, and {@link decodedOf} emits `limit` then
 * whichever of `after` / `offset` the read carries — the order the
 * canonical string keeps.
 */
export const PageWindow = {
  limit: Schema.optionalKey(
    Schema.FiniteFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)))
  ),
  after: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(
    Schema.FiniteFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
  ),
};

/** The decoded shape of a collection's query, as the node-derived codec produces it. */
export interface DecodedQuery {
  readonly include?: ReadonlyArray<string>;
  readonly fields?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly sort?: ReadonlyArray<SortTerm>;
  readonly page?: { readonly limit?: number; readonly after?: string; readonly offset?: number };
  readonly filter?: Filter.Node;
}

/** One collection's query codec and its canonical encoder. */
interface QueryCodec {
  readonly schema: Schema.Codec<DecodedQuery, Readonly<Record<string, unknown>>>;
  readonly canonical: (decoded: DecodedQuery) => string;
}

/** A value derived per node, memoised per registry then per node type. */
const memoised = <A>(
  store: WeakMap<Node.NodeRegistry, Map<string, A>>,
  nodes: Node.NodeRegistry,
  node: Node.AnyNode,
  build: () => A
): A => {
  let byType = store.get(nodes);
  if (byType === undefined) {
    byType = new Map();
    store.set(nodes, byType);
  }
  const cached = byType.get(node.type);
  if (cached !== undefined) return cached;
  const value = build();
  byType.set(node.type, value);
  return value;
};

/** The `include` option of a node's query codecs: single-level paths only (ADR-0028 D1); no edges, no `include` at all. */
const includeOption = (node: Node.AnyNode) =>
  !R.isEmptyReadonlyRecord(node.edges) ? ({ depth: 1 } as const) : false;

const queryCodecs = new WeakMap<Node.NodeRegistry, Map<string, QueryCodec>>();

/** Build (or fetch) the query codec of one node: `Query.schema` over its synthetic resource. */
const codecOf = (nodes: Node.NodeRegistry, node: Node.AnyNode): QueryCodec =>
  memoised(queryCodecs, nodes, node, () => {
    const resource = resourceIn(resourcesOf(nodes), node.type);
    const schema = UrlQuery.schema(resource, {
      include: includeOption(node),
      fields: true,
      sort: node.sortable as ReadonlyArray<Resource.AttributeKeys<Resource.Any>>,
      page: PageWindow,
      filter: true,
    }) as QueryCodec["schema"];
    return {
      schema,
      canonical: UrlQuery.canonical(schema as UrlQuery.FlatQuerySchema) as (
        decoded: DecodedQuery
      ) => string,
    };
  });

/** The node a collection names, or a `QueryError` thrown — a definition-time defect. */
const nodeOrThrow = (nodes: Node.NodeRegistry, collection: string): Node.AnyNode => {
  const node = nodes.nodes.get(collection);
  if (node === undefined) {
    throw new QueryError({ message: `Unknown collection: ${collection}`, query: collection });
  }
  return node;
};

/**
 * The query codec of a collection's `list` endpoint — `include`, `fields[…]`,
 * `sort`, `page[…]` and `filter[…]` exactly as the node graph declares them:
 * the codec {@link parseParams} decodes with, so an effect-jsonapi endpoint
 * served by a derived handler (`RestHandlers.list`) declares the grammar the
 * handler parses when it is passed as `Endpoint.list(R, { query })`.
 * effect-jsonapi's own `filter: true` derives a grammar from the *resource*
 * instead, and the two spell a to-one relationship's filter differently: the
 * resource grammar names the relationship (`filter[category]=c-audio`), the
 * node graph — and every URL the engine emits ({@link canonical}) — names the
 * key field (`filter[categoryId]=c-audio`, as ADR-0029's URLs do). One codec
 * on both sides keeps the endpoint's contract and the handler's parse the
 * same language. Every edge is includable under it, so a resource served
 * with it declares its collection-valued edges `Relationship.many`, never
 * `paginated` (whose `include=` only the resource grammar refuses). Throws a
 * `QueryError` for an unknown collection — a definition-time defect.
 */
export const querySchema = (
  nodes: Node.NodeRegistry,
  collection: string
): Schema.Codec<DecodedQuery, Readonly<Record<string, unknown>>> =>
  codecOf(nodes, nodeOrThrow(nodes, collection)).schema;

/** The decoded shape of a single-resource request's query: `include` and `fields[…]` only. */
export interface SingleRowQuery {
  readonly include?: ReadonlyArray<string>;
  readonly fields?: Readonly<Record<string, ReadonlyArray<string>>>;
}

const singleRowCodecs = new WeakMap<
  Node.NodeRegistry,
  Map<string, Schema.Codec<SingleRowQuery, Readonly<Record<string, unknown>>>>
>();

/**
 * The query codec of a collection's `get` endpoint — `include` and
 * `fields[…]` exactly as the node graph declares them, the two parameters a
 * single-resource request takes ({@link singleRowParams}) — for
 * `Endpoint.get(R, { query })`, the counterpart of {@link querySchema}: the
 * endpoint's contract and the derived handler's parse are one grammar on
 * the single-row route too. Throws a `QueryError` for an unknown collection.
 */
export const singleRowSchema = (
  nodes: Node.NodeRegistry,
  collection: string
): Schema.Codec<SingleRowQuery, Readonly<Record<string, unknown>>> => {
  const node = nodeOrThrow(nodes, collection);
  return memoised(
    singleRowCodecs,
    nodes,
    node,
    () =>
      UrlQuery.schema(resourceIn(resourcesOf(nodes), node.type), {
        include: includeOption(node),
        fields: true,
      }) as Schema.Codec<SingleRowQuery, Readonly<Record<string, unknown>>>
  );
};

// ─── URL → Query.Read ────────────────────────────────────────────────────────

/** A sparse-fieldset projection: attribute names by resource type (ADR-0029 §5). */
export type Projection = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * A parsed URL: the declarative read, the `fields[]` projection beside it,
 * and — from {@link parseRead} of a `/{type}/{id}` path — the row id the
 * path addressed, so the caller knows to write a single-resource document
 * (the read already carries it as `filter[id]`, first 1).
 */
export interface ParsedRead {
  readonly read: Query.Read;
  readonly fields?: Projection;
  readonly id?: string;
}

/** The flat query record: `URLSearchParams` with repeated keys as arrays (as `UrlParams.toRecord` does). */
const recordOf = (
  params: URLSearchParams | Readonly<Record<string, string | ReadonlyArray<string>>>
): Record<string, string | ReadonlyArray<string>> => {
  if (!(params instanceof URLSearchParams)) return { ...params };
  const record: Record<string, string | ReadonlyArray<string>> = {};
  params.forEach((value, key) => {
    const existing = record[key];
    record[key] =
      existing === undefined
        ? value
        : P.isString(existing)
          ? [existing, value]
          : [...existing, value];
  });
  return record;
};

/**
 * The rejection of one query parameter, in the shape every check here
 * raises (`parameter` names the offending key, so a caller answers 400 with
 * `source.parameter`). Exported for a caller that checks a parsed URL
 * against a declaration of its own — the replica-side writer against the
 * resource it is bound to — and must reject the way the codec does.
 */
export const invalidParameter = (
  collection: string,
  parameter: string,
  detail: string
): QueryError =>
  new QueryError({
    message: `Invalid query for "${collection}" (${parameter}): ${detail}`,
    query: collection,
    parameter,
  });

const invalid = invalidParameter;

const nodeOf = (
  nodes: Node.NodeRegistry,
  collection: string
): Effect.Effect<Node.AnyNode, QueryError> => {
  const node = nodes.nodes.get(collection);
  return node === undefined
    ? Effect.fail(
        new QueryError({ message: `Unknown collection: ${collection}`, query: collection })
      )
    : Effect.succeed(node);
};

/** The `include` tokens of the wire value: the comma form, the repeated key, or both. */
const includeTokens = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  value === undefined
    ? []
    : (P.isString(value) ? [value] : value).flatMap((item) => item.split(","));

/**
 * Check `include` before decoding: every path is one of the node's own
 * edges. A nested path is rejected by decision D1; an undeclared edge is
 * rejected so the caller can rule on it (a façade falls through, ADR-0029
 * §1). The codec would reject both too; the check gives the reason.
 */
const checkInclude = (
  node: Node.AnyNode,
  value: string | ReadonlyArray<string> | undefined
): Effect.Effect<void, QueryError> =>
  failFirst(includeTokens(value), (token) =>
    token.includes(".")
      ? Option.some(
          invalid(
            node.type,
            "include",
            `nested include path "${token}" is not supported; a read includes a node's own edges only (ADR-0028 D1)`
          )
        )
      : node.edges[token] === undefined
        ? Option.some(
            invalid(
              node.type,
              "include",
              `"${token}" is not an edge of "${node.type}" (edges: ${Object.keys(node.edges).join(", ")})`
            )
          )
        : Option.none()
  );

/** Fail with the first item's error, in order; succeed when no item has one. */
const failFirst = <A>(
  items: Iterable<A>,
  errorOf: (item: A) => Option.Option<QueryError>
): Effect.Effect<void, QueryError> =>
  Option.match(Arr.findFirst(items, errorOf), { onNone: () => Effect.void, onSome: Effect.fail });

/** One segment of a Standard Schema issue path: a key, or an object carrying one. */
type PathSegment = PropertyKey | { readonly key: PropertyKey };

const keyOf = (segment: PathSegment): PropertyKey =>
  P.isObjectOrArray(segment) ? segment.key : segment;

/** The types a read on the node can carry: its own and its edge targets'. */
const carriedTypes = (node: Node.AnyNode): ReadonlySet<string> =>
  new Set([node.type, ...Object.values(node.edges).map((edge) => edge.target)]);

/**
 * The rejection of a `fields[type]` projection the read cannot carry, or
 * `undefined` when it can. The codec silently drops such a type; a
 * projection nobody can apply is a client mistake worth a 400, and the same
 * rule keeps {@link canonical} and {@link parseParams} in agreement.
 */
const projectionError = (node: Node.AnyNode, type: string): QueryError | undefined => {
  const types = carriedTypes(node);
  return types.has(type)
    ? undefined
    : invalid(
        node.type,
        `fields[${type}]`,
        `"${type}" is not a type this read can carry (types: ${[...types].join(", ")})`
      );
};

/** Check every `fields[…]` key before decoding (see {@link projectionError}). */
const checkFields = (
  node: Node.AnyNode,
  record: Readonly<Record<string, unknown>>
): Effect.Effect<void, QueryError> =>
  failFirst(Object.keys(record), (key) => {
    const match = /^fields\[(.*)\]$/.exec(key);
    return Option.fromUndefinedOr(
      match === null ? undefined : projectionError(node, match[1] ?? "")
    );
  });

/**
 * `page[offset]` and `page[after]` are different pagination idioms — one
 * request names one (#209). The schema alone cannot reject the
 * combination (each key decodes fine on its own), so this runs before
 * decoding, the way {@link checkInclude} rejects a nested path.
 */
const checkPage = (
  node: Node.AnyNode,
  record: Readonly<Record<string, unknown>>
): Effect.Effect<void, QueryError> =>
  record["page[after]"] !== undefined && record["page[offset]"] !== undefined
    ? Effect.fail(
        invalid(
          node.type,
          "page[offset]",
          `"page[offset]" and "page[after]" are different pagination idioms; a request names one`
        )
      )
    : Effect.void;

/** The query-string parameter an issue path names: the flat key itself, or `family[member]` for the nested families. */
const parameterOf = (path: ReadonlyArray<PathSegment> | undefined): string | undefined => {
  const [head, second] = (path ?? []).map(keyOf);
  if (!P.isString(head)) return undefined;
  return (head === "fields" || head === "page") && P.isString(second) ? `${head}[${second}]` : head;
};

/** A codec rejection as a `QueryError` naming the parameter (the issue's path is the flat key). */
const decodeError =
  (collection: string) =>
  (error: Schema.SchemaError): QueryError => {
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0];
    const parameter = parameterOf(issue?.path);
    return new QueryError({
      message: `Invalid query for "${collection}"${parameter === undefined ? "" : ` (${parameter})`}: ${issue?.message ?? error.message}`,
      query: collection,
      parameter,
      cause: error,
    });
  };

/** Sort terms as `order` tokens (`name`, `-createdAt`). */
const orderOf = (sort: ReadonlyArray<SortTerm>): ReadonlyArray<string> =>
  sort.map((term) => (term.direction === "desc" ? `-${term.field}` : term.field));

/**
 * The declarative read a decoded query describes, or the typed `QueryError`
 * {@link fromFilterAst} fails with for `decoded.filter` — unreachable in
 * practice (the module doc's note on this call site), carried as a `Result`
 * rather than thrown so {@link parseParams}'s `Effect.Effect<_, QueryError>`
 * contract holds even if that precondition is ever violated.
 */
const readOf = (
  collection: string,
  decoded: DecodedQuery
): Result.Result<Query.Read, QueryError> => {
  const whereResult =
    decoded.filter === undefined
      ? Result.succeed<Predicate.Predicate | undefined>(undefined)
      : fromFilterAst(decoded.filter);
  return Result.map(whereResult, (where) => ({
    collection,
    ...(where === undefined ? {} : { where }),
    ...(decoded.include === undefined || Arr.isReadonlyArrayEmpty(decoded.include)
      ? {}
      : { include: Object.fromEntries(decoded.include.map((edge) => [edge, true as const])) }),
    ...(decoded.sort === undefined || Arr.isReadonlyArrayEmpty(decoded.sort)
      ? {}
      : { order: orderOf(decoded.sort) }),
    ...(decoded.page?.limit === undefined ? {} : { first: decoded.page.limit }),
    ...(decoded.page?.after === undefined ? {} : { after: decoded.page.after }),
    ...(decoded.page?.offset === undefined ? {} : { offset: decoded.page.offset }),
  }));
};

/**
 * Parse a collection's query parameters into a read. `include`, `fields`,
 * `sort`, `page` and `filter` are decoded with the node-derived query codec
 * (unknown filter fields, undeclared operators, literals of the wrong kind,
 * unsortable fields, unknown sparse fields and nested include paths all
 * fail with a `QueryError` naming the parameter) and mapped onto the read;
 * `fields[]` rides beside it as the projection.
 */
export const parseParams = (
  nodes: Node.NodeRegistry,
  collection: string,
  params: URLSearchParams | Readonly<Record<string, string | ReadonlyArray<string>>>
): Effect.Effect<ParsedRead, QueryError> =>
  Effect.gen(function* () {
    const node = yield* nodeOf(nodes, collection);
    const record = recordOf(params);
    yield* checkInclude(node, record["include"]);
    yield* checkFields(node, record);
    yield* checkPage(node, record);
    const decoded = yield* Schema.decodeUnknownEffect(codecOf(nodes, node).schema)(record).pipe(
      Effect.mapError(decodeError(collection))
    );
    const read = yield* Effect.fromResult(readOf(collection, decoded));
    return {
      read,
      ...(decoded.fields === undefined ? {} : { fields: decoded.fields }),
    };
  });

/** A path segment percent-decoded, or a `QueryError` naming `id` when it is malformed. */
const decodeId = (collection: string, segment: string): Effect.Effect<string, QueryError> =>
  Effect.try({
    try: () => decodeURIComponent(segment),
    catch: () => invalid(collection, "id", `path segment "${segment}" is not percent-encoded`),
  });

/**
 * The resource a request path addresses: `…/{type}/{id}` (one row) when the
 * segment before the last names a node, else `…/{type}` (a listing) when
 * the last does. A node named earlier on the path — the spec's related
 * resource (`/products/p-1/variants`) and relationship (`…/relationships/…`)
 * URLs — is not a read this parser serves (read the related collection
 * with its key filter instead), so it is rejected rather than misread as a
 * whole-collection listing.
 */
const locate = (
  nodes: Node.NodeRegistry,
  url: URL
): Effect.Effect<{ readonly collection: string; readonly id?: string }, QueryError> => {
  const segments = url.pathname.split("/").filter((segment) => Str.isNonEmpty(segment));
  const last = segments.at(-1);
  const previous = segments.at(-2);
  if (previous !== undefined && last !== undefined && nodes.nodes.has(previous)) {
    return Effect.map(decodeId(previous, last), (id) => ({ collection: previous, id }));
  }
  const message = segments.slice(0, -2).some((segment) => nodes.nodes.has(segment))
    ? `Nested resource path "${url.pathname}" is not a read; filter the related collection by its key instead`
    : last !== undefined && nodes.nodes.has(last)
      ? undefined
      : `No collection on path "${url.pathname}"`;
  return message === undefined && last !== undefined
    ? Effect.succeed({ collection: last })
    : Effect.fail(
        new QueryError({
          message: message ?? `No collection on path "${url.pathname}"`,
          query: url.pathname,
        })
      );
};

/**
 * The query of a single-row read — `filter[id]=…`, first 1 (ADR-0029 §3) —
 * from a `/{type}/{id}` request's own query, which takes `include` and
 * `fields[…]` only. Shared by {@link parseRead} and the derived `get`
 * handler, which has the id from the route instead of the path.
 */
export const singleRowParams = (
  collection: string,
  id: string,
  params: URLSearchParams
): Effect.Effect<URLSearchParams, QueryError> => {
  const extra = Arr.findFirst(
    params.keys(),
    (key) => key !== "include" && !key.startsWith("fields[")
  );
  if (Option.isSome(extra)) {
    return Effect.fail(
      invalid(
        collection,
        extra.value,
        `a single-resource request takes "include" and "fields[…]" only`
      )
    );
  }
  const widened = new URLSearchParams(params);
  // Through the grammar's own encoder, so an id carrying `,` or `\` is
  // escaped as a literal rather than read as a list.
  widened.set("filter[id]", flatFilter(Filter.eq("id", id))["filter[id]"] ?? "");
  widened.set("page[limit]", "1");
  return Effect.succeed(widened);
};

/**
 * Parse a request URL into a read. The collection is the path's last
 * segment that names a node (`/api/products?…`, any prefix), or the
 * segment before a row id (`/api/products/p-1?…`, which reads as
 * `filter[id]=p-1` with `first` 1). The query is then {@link parseParams}.
 */
export const parseRead = (
  nodes: Node.NodeRegistry,
  url: string | URL
): Effect.Effect<ParsedRead, QueryError> =>
  Effect.gen(function* () {
    const parsed = P.isString(url) ? new URL(url, "http://localhost") : url;
    const located = yield* locate(nodes, parsed);
    const params =
      located.id === undefined
        ? parsed.searchParams
        : yield* singleRowParams(located.collection, located.id, parsed.searchParams);
    const result = yield* parseParams(nodes, located.collection, params);
    return located.id === undefined ? result : { ...result, id: located.id };
  });

// ─── Query.Read → canonical string ───────────────────────────────────────────

const noUrlForm = (collection: string, detail: string): QueryError =>
  new QueryError({
    message: `Read on "${collection}" has no URL form: ${detail}`,
    query: collection,
  });

/** The plan's edge selects as include paths, in code-point order (the include set is unordered). */
const includeOf = (collection: string, edges: Query.Plan["edges"]): ReadonlyArray<string> =>
  edges
    .map((edge) => {
      if (edge.first !== undefined) {
        throw noUrlForm(
          collection,
          `the per-edge window on "${edge.edge}" (include: { first }) has no query parameter`
        );
      }
      return edge.edge;
    })
    .toSorted((a, b) => Predicate.compareText(a, b));

const astOf = (collection: string, predicate: Predicate.Predicate): Filter.Node =>
  Option.getOrThrowWith(toFilterAst(predicate), () =>
    noUrlForm(collection, `"${predicate._tag}" carries an Exists node or a null literal`)
  );

/** Passes {@link filterOf} allows the normal form to settle in; two suffice in practice. */
const NORMAL_FORM_PASSES = 8;

/**
 * The plan's root predicate as a filter AST in normal form; `undefined` for
 * the whole collection. Two normalisations meet here: {@link foldConstants}
 * on the engine side (constants, singleton groups) and `Filter.normalise`
 * on the grammar side (member order, deduplication, literal-list order).
 * Each can hand the other new work — deduplicating `Or(x, x)` leaves a
 * singleton group the fold then collapses — so the result is their
 * fixpoint, which makes {@link canonical} idempotent: parsing a canonical
 * string and canonicalising again gives the same string.
 */
const filterOf = (
  collection: string,
  declaration: Filter.LiteralCodecs,
  where: Predicate.Predicate
): Filter.Node | undefined => {
  const settle = (predicate: Predicate.Predicate, pass: number): Option.Option<Filter.Node> => {
    if (pass >= NORMAL_FORM_PASSES) return Option.some(astOf(collection, predicate));
    if (isTrue(predicate)) return Option.none();
    const ast = Filter.normalise(astOf(collection, predicate), declaration);
    // Safe by construction, not merely by convention: `ast` was normalised
    // from `astOf`'s output, whose every literal is copied verbatim from a
    // `Predicate.Literal` (`toFilterAst`'s `Compare` case) — already a wire
    // scalar, so `literalOf` cannot reject it. Defect-by-contract for this
    // one call site; the module doc explains why the exported function
    // still returns a typed failure for its general contract.
    const back = fromFilterAst(ast);
    if (Result.isFailure(back)) throw back.failure;
    const next = foldConstants(back.success);
    if (JSON.stringify(next) === JSON.stringify(predicate)) return Option.some(ast);
    return settle(next, pass + 1);
  };
  return Option.getOrUndefined(settle(foldConstants(where), 0));
};

/**
 * The decoded query a compiled read denotes. The page comes from the
 * **read**, not the compiled window: an offset read's `root.limit`
 * absorbs `offset` (`Query.plan`'s `rootLimit`, #209), so reconstructing
 * `page[limit]`/`page[after]` from `root` would leak the inflated fetch
 * size into the URL instead of the request the caller actually made.
 */
const decodedOf = (
  compiled: Query.Plan,
  declaration: Filter.LiteralCodecs,
  fields: Projection | undefined,
  read: Query.Read
): DecodedQuery => {
  const { root } = compiled;
  const include = includeOf(root.collection, compiled.edges);
  const filter = filterOf(root.collection, declaration, root.where);
  const page =
    read.offset === undefined
      ? {
          ...(root.limit === undefined ? {} : { limit: root.limit }),
          ...(root.cursor === undefined ? {} : { after: root.cursor }),
        }
      : { ...(read.first === undefined ? {} : { limit: read.first }), offset: read.offset };
  return {
    ...(Arr.isReadonlyArrayEmpty(include) ? {} : { include }),
    ...(fields === undefined ? {} : { fields: projectionOf(fields) }),
    ...(filter === undefined ? {} : { filter }),
    ...(Arr.isReadonlyArrayEmpty(root.orderBy) ? {} : { sort: root.orderBy }),
    ...(R.isEmptyReadonlyRecord<string, unknown>(page) ? {} : { page }),
  };
};

/** A projection with each type's field list in code-point order (a set). */
const projectionOf = (fields: Projection): Projection =>
  Object.fromEntries(
    Object.entries(fields).map(([type, names]) => [type, names.toSorted(Predicate.compareText)])
  );

/**
 * The canonical URL of a read — `/{collection}?{query}` (no API prefix;
 * `parseRead` accepts it back) — through effect-jsonapi's canonical encoder
 * over the compiled plan: one string per plan, whatever spelling the read
 * used (`where` as a map or a predicate, conjuncts in any order, `True`
 * conjuncts). It is the subscription identity of ADR-0029 §2. Throws a
 * `QueryError` for a read the plan or the grammar refuses: an unknown
 * collection or edge, a field outside the filterable set, an `Exists`, a
 * `null` literal, or a per-edge window. A `fields[]` projection rides
 * along when given.
 */
export const canonical = (
  nodes: Node.NodeRegistry,
  read: Query.Read,
  fields?: Projection
): string => {
  const compiled = Query.plan(nodes, read);
  const node = nodes.nodes.get(read.collection);
  if (node === undefined) {
    throw new QueryError({
      message: `Unknown collection: ${read.collection}`,
      query: read.collection,
    });
  }
  Object.keys(fields ?? {}).forEach((type) => {
    const error = projectionError(node, type);
    if (error !== undefined) throw error;
  });
  const encoded = Result.try({
    try: () => {
      const declaration = Resource.filterable(resourceIn(resourcesOf(nodes), node.type));
      return codecOf(nodes, node).canonical(decodedOf(compiled, declaration, fields, read));
    },
    catch: (error) =>
      error instanceof QueryError
        ? error
        : new QueryError({
            message: `Read on "${read.collection}" has no URL form: ${error instanceof Error ? error.message : String(error)}`,
            query: read.collection,
            cause: error,
          }),
  });
  if (Result.isFailure(encoded)) throw encoded.failure;
  const query = encoded.success;
  return query === "" ? `/${read.collection}` : `/${read.collection}?${query}`;
};

/** {@link canonical} as an effect: the `QueryError` it throws becomes a typed failure. */
const tryCanonical = (
  nodes: Node.NodeRegistry,
  read: Query.Read
): Effect.Effect<string, QueryError> =>
  Effect.suspend(() => {
    const result = Result.try(() => canonical(nodes, read));
    if (Result.isSuccess(result)) return Effect.succeed(result.success);
    return result.failure instanceof QueryError
      ? Effect.fail(result.failure)
      : Effect.die(result.failure);
  });

/**
 * The `Client.UrlReads` seam over this bridge (#159, ADR-0029 §2): pass as
 * `urls` to `Client.make` / `Client.connect` / `Client.fromView` so
 * `client.subscribe(url)` parses through {@link parseRead} and keys the pin
 * by {@link canonical}, and to an engine host (`ServiceWorkerHost.run`) so
 * a page with no Client can register by URL. The `fields[]` projection a
 * URL carries is dropped: it never changes what a subscription syncs
 * (ADR-0029 §5), so two URLs differing only in `fields[]` are one
 * subscription.
 */
export const urlReads = (nodes: Node.NodeRegistry): Client.UrlReads => ({
  parse: (url) => Effect.map(parseRead(nodes, url), (parsed) => parsed.read),
  canonical: (read) => tryCanonical(nodes, read),
});

// ─── The exact encoder ───────────────────────────────────────────────────────

/** The attribute schema of a field whose literals have the JS type. */
const scalarSchema = (type: "string" | "number" | "boolean"): Schema.Top =>
  type === "string" ? Schema.String : type === "number" ? Schema.Number : Schema.Boolean;

/** Collect the literal JS types each field of a tree is compared with (mutates `types`). */
const collectLiteralTypes = (ast: Filter.Node, types: Map<string, Set<string>>): void => {
  const add = (field: string, value: unknown) => {
    const set = types.get(field) ?? new Set<string>();
    set.add(typeof value);
    types.set(field, set);
  };
  switch (ast._tag) {
    case "Compare":
      return add(ast.field, ast.value);
    case "In":
    case "NotIn":
      return ast.values.forEach((value) => add(ast.field, value));
    case "IsNull":
      return void (types.get(ast.field) ?? types.set(ast.field, new Set()));
    case "And":
    case "Or":
      return ast.members.forEach((member) => collectLiteralTypes(member, types));
    case "Not":
      return collectLiteralTypes(ast.member, types);
  }
};

/** The one JS type each field of a tree is compared with (`string` for a field only null-tested). */
const literalTypesOf = (ast: Filter.Node): ReadonlyMap<string, string> => {
  const types = new Map<string, Set<string>>();
  collectLiteralTypes(ast, types);
  const resolved = new Map<string, string>();
  types.forEach((kinds, field) => {
    const [kind, ...rest] = kinds;
    if (Arr.isReadonlyArrayNonEmpty(rest)) {
      throw new QueryError({
        message: `Field "${field}" is compared with literals of several types (${[...kinds].join(", ")}); ADR-0028 rule (d) admits one`,
        parameter: `filter[${field}]`,
      });
    }
    resolved.set(field, kind ?? "string");
  });
  return resolved;
};

/** The flat `filter[...]` codec of an untyped declaration. */
type FlatFilterCodec = Schema.Codec<Filter.Node, Readonly<Record<string, string>>>;

const flatFilterCodecs = new Map<string, FlatFilterCodec>();

/**
 * The codec for encoding a tree without a node graph: each field it names
 * admits every operator, typed by the JS type of its literals. The wire
 * form of a scalar does not depend on its declared kind, so this encodes
 * exactly what the typed codec would. Memoised by the field → type
 * signature, since a backend encodes the same shapes on every pull.
 */
const flatFilterCodecOf = (ast: Filter.Node): FlatFilterCodec => {
  const types = literalTypesOf(ast);
  const signature = [...types]
    .map(([field, type]) => `${field}:${type}`)
    .toSorted(Predicate.compareText)
    .join("\n");
  const cached = flatFilterCodecs.get(signature);
  if (cached !== undefined) return cached;
  const attributes = R.fromIterableWith(types, ([field, type]): [string, Schema.Top] => [
    field,
    scalarSchema(type as "string" | "number" | "boolean").pipe(Filter.able()),
  ]);
  const codec = UrlQuery.Filter(Resource.make("query", { attributes })) as FlatFilterCodec;
  flatFilterCodecs.set(signature, codec);
  return codec;
};

/**
 * The canonical flat `filter[...]` record of a filter AST — the grammar's
 * own encoder (`Query.Filter`), so the shorthand, the group form, escaping
 * and member order are effect-jsonapi's byte for byte.
 */
export const flatFilter = (ast: Filter.Node): Readonly<Record<string, string>> =>
  Schema.encodeSync(flatFilterCodecOf(ast))(ast);

/**
 * Serialize sort terms into the JSON:API `sort` value (`-field,field`) through
 * the library's `Query.Sort` codec, so the wire encoding matches the spec's
 * descending-prefix convention by construction.
 *
 * Since effect-jsonapi 0.15 the codec's encoded side is `Repeatable`
 * (`string | ReadonlyArray<string>`) because it also decodes the repeated-key
 * spelling; its encoder emits the comma form, and an array is joined into
 * that same form rather than trusted to never appear.
 */
const encodeSort = (terms: ReadonlyArray<SortTerm>): string => {
  const encoded = Schema.encodeSync(UrlQuery.Sort(terms.map((term) => term.field)))(
    terms.map((term) => ({ field: term.field, direction: term.direction }))
  );
  return P.isString(encoded) ? encoded : encoded.join(",");
};

/**
 * Build the JSON:API query string (with its leading `?`, or `` when empty)
 * for `include` / `fields` / `filter` / `sort` / `page`, in the canonical
 * family order and percent-encoding (`Query.serialise`). `filter` is a
 * filter AST, encoded exactly through {@link flatFilter}.
 */
export const buildQueryString = (options?: JsonApiRequestOptions): string => {
  if (options === undefined) return "";
  const pairs: Array<UrlQuery.Pair> = [];
  if (options.include && Arr.isReadonlyArrayNonEmpty(options.include))
    pairs.push(["include", options.include.join(",")]);
  pairs.push(
    ...Object.entries(options.fields ?? {}).map(([type, names]): UrlQuery.Pair => [
      `fields[${type}]`,
      names.join(","),
    ])
  );
  if (options.filter !== undefined) pairs.push(...Object.entries(flatFilter(options.filter)));
  if (options.sort && Arr.isReadonlyArrayNonEmpty(options.sort))
    pairs.push(["sort", encodeSort(options.sort)]);
  pairs.push(
    ...Object.entries(options.page ?? {}).flatMap(([key, value]): Array<UrlQuery.Pair> =>
      value === undefined ? [] : [[`page[${key}]`, String(value)]]
    )
  );
  const query = UrlQuery.serialise(pairs);
  return query === "" ? "" : `?${query}`;
};

/**
 * Encode a subset into a JSON:API query string (incl. leading `?`, or ``),
 * or `None` when no row can match it (the request is skipped). A predicate
 * without a URL form is a `QueryError`: the backend fails closed.
 */
export interface QueryEncoder {
  readonly encode: (subset: Subset.Subset) => Effect.Effect<Option.Option<string>, QueryError>;
}

/**
 * The request options a subset encodes to, or `None` when its predicate
 * folds to false. The filter is the whole predicate, constants folded;
 * `orderBy` becomes `sort`. Limit and cursor are not pushed: the window is
 * applied locally over the exact filter. Throws a `QueryError` for a
 * predicate with no URL form (`Exists`, a `null` literal).
 */
export const toRequestOptions = (subset: Subset.Subset): Option.Option<JsonApiRequestOptions> => {
  const where = foldConstants(subset.where);
  if (isFalse(where)) return Option.none();
  const filter = isTrue(where)
    ? undefined
    : Option.getOrThrowWith(toFilterAst(where), () =>
        noUrlForm(subset.collection, "the predicate carries an Exists node or a null literal")
      );
  const sort = subset.orderBy.map((term) => ({ field: term.field, direction: term.direction }));
  return Option.some({
    ...(filter === undefined ? {} : { filter }),
    ...(Arr.isReadonlyArrayEmpty(sort) ? {} : { sort }),
  });
};

/** The shipped encoder: exact under ADR-0028 (see the module doc). */
export const defaultEncoder: QueryEncoder = {
  encode: (subset) =>
    Effect.try({
      try: () => Option.map(toRequestOptions(subset), buildQueryString),
      catch: (error) =>
        error instanceof QueryError
          ? error
          : new QueryError({
              message: `Subset on "${subset.collection}" could not be encoded: ${error instanceof Error ? error.message : String(error)}`,
              query: subset.collection,
              cause: error,
            }),
    }),
};
