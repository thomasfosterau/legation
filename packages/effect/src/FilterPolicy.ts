/**
 * FilterPolicy
 *
 * The **filterable set** (ADR-0028 rule d, issue #154): the attributes of a
 * node a client may filter or sort by, each with the operators it accepts
 * and the literal kind its values must carry. Declared on the Node
 * (`Node.make`'s `filterable` / `sortable` options), carried onto the
 * derived Collection exactly as `indexes` is, and enforced by
 * `Authorization.authorize` before an auth filter is AND-ed in and before
 * `Backend.evaluate` runs — so an undeclared column is unreachable by
 * construction, not by the good behaviour of every evaluator.
 *
 * Two things are server-authored and therefore exempt from the check: the
 * auth filter's own predicate, and the subsets a named-query resolver
 * produces (`SyncServer` authorises those with `origin: "server"`).
 *
 * The operator vocabulary is the grammar's full core (ADR-0028 §3):
 * `eq ne lt lte gt gte in nin isnull`. Today's `Predicate` union carries
 * `Compare`, `In` and the connectives; `nin` and `isnull` are declarable
 * now so a declaration stays valid once #155 adds the `NotIn` and `IsNull`
 * nodes. Until then a `Compare` against a `null` literal is the wire form
 * of `isnull` (ADR-0028 §5) and is checked against that operator.
 */

import { SchemaAST } from "effect";
import { AuthorizationError, FilterDeclarationError } from "./Errors.js";
import type { Literal, Predicate } from "./Predicate.js";
import type { OrderBy } from "./Subset.js";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** A comparison operator of the filter grammar (ADR-0028 §3). */
export type FilterOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "nin" | "isnull";

/** Every {@link FilterOperator}, in grammar order. */
export const operators: ReadonlyArray<FilterOperator> = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "nin",
  "isnull",
];

/**
 * The literal kind of a filterable attribute (ADR-0028 §2(e), §4). The kind
 * cannot always be read off a JS literal — `text` and `instant` are both
 * strings, `integer` and `double` both numbers — so the declaration carries
 * it: the SQL compilers bind and collate by it (#156), and `authorize`
 * checks every client literal against it.
 */
export type LiteralKind = "text" | "integer" | "double" | "boolean" | "instant";

/** One filterable attribute: its literal kind and the operators it accepts. */
export interface FilterableField {
  readonly kind: LiteralKind;
  readonly operators: ReadonlyArray<FilterOperator>;
}

/** A collection's filterable set: filterable attributes plus sortable ones. */
export interface FilterDeclaration {
  readonly filterable: Readonly<Record<string, FilterableField>>;
  readonly sortable: ReadonlyArray<string>;
}

/**
 * The per-field form `Node.make` accepts: the operators alone (the kind is
 * derived from the attribute schema), or operators with an explicit kind
 * (required where derivation cannot tell, e.g. an `instant` stored as text).
 */
export type FilterableInput =
  | ReadonlyArray<FilterOperator>
  | { readonly operators: ReadonlyArray<FilterOperator>; readonly kind?: LiteralKind };

/**
 * What a key field (`id`, or a `one`-edge's `via` field) is filterable by
 * when nothing else is declared: `eq` / `in` over text — the shape edge
 * windows (`fk = parent`, `id IN (…)`) and allow-set auth filters already
 * depend on.
 */
export const keyDefaults: FilterableField = { kind: "text", operators: ["eq", "in"] };

/**
 * The declaration a collection with no declaration at all is checked
 * against: `id` by `eq` / `in`, sortable by `id` (ADR-0026's tie-break).
 */
export const bare: FilterDeclaration = { filterable: { id: keyDefaults }, sortable: ["id"] };

// ─── Kind derivation ─────────────────────────────────────────────────────────

const INT_CHECK_ID = "effect/schema/isInt";

/** Whether any check on the node (recursing into groups) is `Schema.isInt`. */
const hasIntCheck = (checks: SchemaAST.Checks | undefined): boolean =>
  checks !== undefined &&
  checks.some((check) =>
    check._tag === "FilterGroup"
      ? hasIntCheck(check.checks)
      : check.annotations?.representation?.id === INT_CHECK_ID
  );

const kindOfAst = (ast: SchemaAST.AST): LiteralKind | undefined => {
  switch (ast._tag) {
    case "String":
      return "text";
    case "Number":
      return hasIntCheck(ast.checks) ? "integer" : "double";
    case "Boolean":
      return "boolean";
    case "Literal":
      return typeof ast.literal === "string"
        ? "text"
        : typeof ast.literal === "number"
          ? "double"
          : typeof ast.literal === "boolean"
            ? "boolean"
            : undefined;
    case "Union": {
      // `NullOr` / `optional` / `Literals`: the members' one common kind.
      const kinds = new Set<LiteralKind>();
      for (const member of ast.types) {
        if (member._tag === "Null" || member._tag === "Undefined") continue;
        const kind = kindOfAst(member);
        if (kind === undefined) return undefined;
        kinds.add(kind);
      }
      return kinds.size === 1 ? [...kinds][0] : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * The default literal kind of an attribute, read off its schema's **encoded**
 * form (the wire type a client literal is compared with): a `String` is
 * `text`, a `Number` is `double` unless it carries `Schema.isInt` (then
 * `integer`), a `Boolean` is `boolean`; literals and nullable / optional
 * unions resolve to their members' one kind. `instant` is never derived — a
 * string is a string on the wire — so an instant attribute declares its kind
 * explicitly. `undefined` where nothing can be said (a declaration such as
 * `Schema.Date`, an object, an array).
 */
export const kindOf = (schema: { readonly ast: SchemaAST.AST }): LiteralKind | undefined =>
  kindOfAst(SchemaAST.toEncoded(schema.ast));

// ─── Resolution (definition time) ────────────────────────────────────────────

/** What {@link resolve} needs from a node definition. */
export interface ResolveOptions {
  readonly collection: string;
  /** The scalar attributes, by field name — the kind derivation source. */
  readonly attributes: Readonly<Record<string, { readonly ast: SchemaAST.AST }>>;
  /** The key fields defaulting to {@link keyDefaults}: `id` plus every `one`-edge `via`. */
  readonly keyFields: ReadonlyArray<string>;
  readonly filterable?: Readonly<Record<string, FilterableInput>> | undefined;
  readonly sortable?: ReadonlyArray<string> | undefined;
}

/**
 * Resolve a node's declaration: the key defaults first, then each declared
 * field with its operators and its explicit or derived kind; `sortable`
 * always includes `id`. A field the row does not carry, or an attribute
 * whose kind cannot be derived and is not given, is a definition-time
 * defect (a thrown {@link FilterDeclarationError}), never a runtime failure.
 */
export const resolve = (options: ResolveOptions): FilterDeclaration => {
  const known = new Set<string>([...options.keyFields, ...Object.keys(options.attributes)]);
  const filterable: Record<string, FilterableField> = {};
  for (const [field, input] of Object.entries(options.filterable ?? {})) {
    if (!known.has(field)) {
      throw new FilterDeclarationError({
        collection: options.collection,
        field,
        message: `Collection "${options.collection}" declares filterable field "${field}", which is not a field of its row`,
      });
    }
    const declared = Array.isArray(input)
      ? { operators: input as ReadonlyArray<FilterOperator> }
      : (input as {
          readonly operators: ReadonlyArray<FilterOperator>;
          readonly kind?: LiteralKind;
        });
    const attribute = options.attributes[field];
    const kind =
      declared.kind ??
      (attribute === undefined ? keyDefaults.kind : kindOf(attribute)) ??
      undefined;
    if (kind === undefined) {
      throw new FilterDeclarationError({
        collection: options.collection,
        field,
        message: `Collection "${options.collection}" cannot derive a literal kind for filterable field "${field}"; declare its kind explicitly (text, integer, double, boolean or instant)`,
      });
    }
    filterable[field] = { kind, operators: [...new Set(declared.operators)] };
  }
  for (const field of options.sortable ?? []) {
    if (!known.has(field)) {
      throw new FilterDeclarationError({
        collection: options.collection,
        field,
        message: `Collection "${options.collection}" declares sortable field "${field}", which is not a field of its row`,
      });
    }
  }
  return withKeyDefaults(options.keyFields, filterable, options.sortable ?? []);
};

/**
 * Overlay a declaration on the key defaults: every key field (`id`, a
 * `one`-edge / relationship key) is filterable by at least `eq` / `in` — a
 * declaration naming one **widens** it, never replaces it, because the
 * engine's own edge windows (`fk = parent`, `id IN (…)`) depend on those
 * operators — and `id` is always sortable (ADR-0026's tie-break). Shared by
 * the Node resolution above and `Collection.filterDeclarationOf`.
 */
export const withKeyDefaults = (
  keyFields: ReadonlyArray<string>,
  filterable: Readonly<Record<string, FilterableField>>,
  sortable: ReadonlyArray<string>
): FilterDeclaration => {
  const merged: Record<string, FilterableField> = {};
  for (const field of keyFields) merged[field] = keyDefaults;
  for (const [field, declared] of Object.entries(filterable)) {
    const base = merged[field];
    merged[field] =
      base === undefined
        ? declared
        : {
            kind: declared.kind,
            operators: [...new Set([...base.operators, ...declared.operators])],
          };
  }
  return { filterable: merged, sortable: [...new Set(["id", ...sortable])] };
};

// ─── Enforcement (request time) ──────────────────────────────────────────────

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
/** `Date#toISOString`'s fixed-width UTC form (ADR-0028 §2(e)). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether a (non-null) literal is a value of the kind. */
export const matchesKind = (kind: LiteralKind, value: Literal): boolean => {
  switch (kind) {
    case "text":
      return typeof value === "string";
    case "instant":
      return typeof value === "string" && INSTANT.test(value);
    case "double":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= INT4_MIN &&
        value <= INT4_MAX
      );
    case "boolean":
      return typeof value === "boolean";
  }
};

const deny = (collection: string, message: string): AuthorizationError =>
  new AuthorizationError({ message: `Collection "${collection}": ${message}`, collection });

const fieldCheck = (
  collection: string,
  declaration: FilterDeclaration,
  field: string,
  operator: FilterOperator
): AuthorizationError | undefined => {
  const declared = declaration.filterable[field];
  if (declared === undefined) {
    return deny(
      collection,
      `field "${field}" is not filterable (filterable: ${Object.keys(declaration.filterable).join(", ")})`
    );
  }
  if (!declared.operators.includes(operator)) {
    return deny(
      collection,
      `field "${field}" is not filterable with "${operator}" (declared: ${declared.operators.join(", ")})`
    );
  }
  return undefined;
};

const literalCheck = (
  collection: string,
  declaration: FilterDeclaration,
  field: string,
  operator: FilterOperator,
  value: Literal
): AuthorizationError | undefined => {
  const kind = declaration.filterable[field]!.kind;
  return value !== null && matchesKind(kind, value)
    ? undefined
    : deny(
        collection,
        `literal ${JSON.stringify(value)} for field "${field}" ("${operator}") does not match its kind "${kind}"`
      );
};

/** An `In` node checked as `in`, or as `nin` when it sits under `Not`. */
const inCheck = (
  collection: string,
  declaration: FilterDeclaration,
  node: { readonly field: string; readonly values: ReadonlyArray<Literal> },
  operator: "in" | "nin"
): AuthorizationError | undefined => {
  const failed = fieldCheck(collection, declaration, node.field, operator);
  if (failed !== undefined) return failed;
  for (const value of node.values) {
    const mismatch = literalCheck(collection, declaration, node.field, operator, value);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
};

/** Whether a `Compare` is the wire form of `isnull` (a null literal on `eq` / `ne`; ADR-0028 §5). */
const isNullTest = (node: { readonly op: string; readonly value: Literal }): boolean =>
  node.value === null && (node.op === "eq" || node.op === "ne");

/**
 * Check a client-authored predicate against a collection's declaration:
 * every `Compare` / `In` names a declared field with that operator and a
 * literal of the field's kind; `Exists` is refused anywhere (only an auth
 * filter may introduce it); the connectives recurse. `undefined` means the
 * predicate is admissible.
 *
 * Today's wire forms of the grammar's `nin` and `isnull` are `Not(In)` and
 * `Compare` against a null literal (negated under `Not`); each is checked
 * against the operator it desugars to, so a `nin`-only declaration admits
 * `Not(In)` and an `in`-only one does not. #155's `NotIn` / `IsNull` nodes
 * slot in beside them.
 */
export const checkWhere = (
  collection: string,
  declaration: FilterDeclaration,
  where: Predicate
): AuthorizationError | undefined => {
  switch (where._tag) {
    case "True":
      return undefined;
    case "Compare": {
      if (where.value === null) {
        return isNullTest(where)
          ? fieldCheck(collection, declaration, where.field, "isnull")
          : deny(
              collection,
              `literal null for field "${where.field}" ("${where.op}") is not a comparable value`
            );
      }
      return (
        fieldCheck(collection, declaration, where.field, where.op) ??
        literalCheck(collection, declaration, where.field, where.op, where.value)
      );
    }
    case "In":
      return inCheck(collection, declaration, where, "in");
    case "And":
    case "Or": {
      for (const predicate of where.predicates) {
        const failed = checkWhere(collection, declaration, predicate);
        if (failed !== undefined) return failed;
      }
      return undefined;
    }
    case "Not": {
      const inner = where.predicate;
      if (inner._tag === "In") return inCheck(collection, declaration, inner, "nin");
      if (inner._tag === "Compare" && isNullTest(inner)) {
        return fieldCheck(collection, declaration, inner.field, "isnull");
      }
      return checkWhere(collection, declaration, inner);
    }
    case "Exists":
      return deny(collection, `"Exists" is not allowed in a client predicate`);
    default:
      return deny(
        collection,
        `predicate node "${(where as { readonly _tag: string })._tag}" is not allowed in a client predicate`
      );
  }
};

/** Check a client-authored `orderBy`: every field must be sortable. */
export const checkOrderBy = (
  collection: string,
  declaration: FilterDeclaration,
  orderBy: ReadonlyArray<OrderBy>
): AuthorizationError | undefined => {
  for (const term of orderBy) {
    if (!declaration.sortable.includes(term.field)) {
      return deny(
        collection,
        `field "${term.field}" is not sortable (sortable: ${declaration.sortable.join(", ")})`
      );
    }
  }
  return undefined;
};

/** {@link checkWhere} then {@link checkOrderBy} over one subset's client-authored parts. */
export const check = (
  collection: string,
  declaration: FilterDeclaration,
  subset: { readonly where: Predicate; readonly orderBy: ReadonlyArray<OrderBy> }
): AuthorizationError | undefined =>
  checkWhere(collection, declaration, subset.where) ??
  checkOrderBy(collection, declaration, subset.orderBy);
