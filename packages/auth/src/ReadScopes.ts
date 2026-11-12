/**
 * ReadScopes
 *
 * effect-auth's compiled read scopes as legation auth filters. effect-auth
 * compiles a declarative policy set into one principal's read scope over a
 * resource type (`ReadScope.compile(policies, binding, request)` →
 * `Exact { scope } | Inexact { reasons }`); this module translates that scope
 * into an `Authorization.ReadScope` over the collection's rows, which the sync
 * server AND-s into every subscription.
 *
 * The translation is exact, and where it cannot be it **narrows, never
 * widens**:
 *
 * - `AllowAll` → `AllowAll` (the role short-circuit: no predicate at all);
 *   `Deny` → `Deny`; `Filter` → `Authorization.filter` with the app's named sets.
 * - Field names come from an explicit per-collection `attributes` map
 *   (effect-auth attribute → row field), checked when the mapping is built
 *   ({@link mapping}): an attribute the binding declares and the map does not
 *   name is a {@link ScopeMappingError} then, not per request.
 * - effect-auth's predicate is two-valued: `Eq`, `Compare` and `InSet` are
 *   false on an absent attribute, and `Not` is plain negation. legation's is
 *   Postgres's three-valued logic (ADR-0028). Each such atom is translated
 *   guarded by `IS NOT NULL` (`a IS NOT NULL AND a = v`), which is definite on
 *   a NULL row, so the translated predicate admits exactly the rows
 *   effect-auth's `matches` admits.
 * - Literals (ADR-0028 rule e): `Text` → string, `Integer` → a safe integer,
 *   `Double` → a finite number, `Boolean` → boolean, `Instant(ms)` →
 *   `new Date(ms).toISOString()`, for whole milliseconds in years 0000–9999
 *   (the fixed-width format whose text order is chronological order).
 * - Anything else — an `Inexact` compilation, a node with no exact
 *   translation, an unmapped attribute, a literal outside its kind's domain, a
 *   failing or defecting compile — is a typed {@link ScopeMappingError}, and
 *   the auth filter ({@link toAuthFilter}) answers `Deny` for it, logged by
 *   collection and reason. It never drops a conjunct and never falls back to
 *   `AllowAll`.
 *
 * Named sets: each set an effect-auth `SetFact` names must have an app-declared
 * `Authorization.NamedSet` ({@link mapping} checks it). The translated
 * predicate refers to the set by name (`Predicate.inSet`), so a subscription's
 * authored scope is stable while the set's members move; a set that fails to
 * resolve binds to nothing and narrows (legation's own rule).
 */

import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ReadScope as AuthScope, type Policy } from "@thomasfosterau/effect-auth";
import {
  Authorization,
  type AuthorizationError,
  type Backend,
  type Collection,
  Predicate,
} from "@thomasfosterau/legation";
import * as Principal from "./Principal.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Why a scope could not be translated exactly:
 *
 * - `Inexact` — effect-auth compiled the policy set `Inexact`.
 * - `UnmappedAttribute` — an attribute has no row field in the `attributes` map.
 * - `UnknownAttribute` — the `attributes` map names an attribute the binding does not declare.
 * - `UndeclaredSet` — a set fact names a set with no app-declared `NamedSet`.
 * - `UnmappableNode` — a predicate node with no exact translation (a `Compare` on text or booleans).
 * - `LiteralKind` — a literal of a different kind from the attribute's.
 * - `LiteralOutOfDomain` — a literal outside its kind's domain (an unsafe integer, a non-finite double, an instant off the ISO range).
 * - `CompileFailed` — the compile step failed or died.
 */
export const ScopeMappingReason = Schema.Literals([
  "Inexact",
  "UnmappedAttribute",
  "UnknownAttribute",
  "UndeclaredSet",
  "UnmappableNode",
  "LiteralKind",
  "LiteralOutOfDomain",
  "CompileFailed",
]);

/** {@inheritDoc ScopeMappingReason} */
export type ScopeMappingReason = typeof ScopeMappingReason.Type;

/**
 * A read scope that cannot be translated exactly. Raised by {@link mapping}
 * when a mapping is built, and by {@link translate} per request, where the
 * auth filter answers `Deny` for it. Its message names collections,
 * attributes and policy reasons only: never a credential or a row value.
 */
export class ScopeMappingError extends Schema.TaggedError<
  ScopeMappingError,
  { readonly brand: unique symbol }
>()("ScopeMappingError", {
  collection: Schema.String,
  reason: ScopeMappingReason,
  message: Schema.String,
}) {}

const failure = (
  collection: string,
  reason: ScopeMappingReason,
  message: string
): Result.Result<never, ScopeMappingError> =>
  Result.fail(new ScopeMappingError({ collection, reason, message }));

// ─── The mapping ─────────────────────────────────────────────────────────────

/** What {@link mapping} checks and builds a {@link Mapping} from. */
export interface MappingOptions {
  /** The legation collection the scope filters. */
  readonly collection: string;
  /** The effect-auth binding the policy set is compiled against. */
  readonly binding: AuthScope.Binding;
  /**
   * effect-auth attribute → row field, for every attribute of the binding and
   * every set fact's attribute. A to-one edge maps to its key (`owner` →
   * `ownerId`, the edge's `via`).
   */
  readonly attributes: Readonly<Record<string, string>>;
  /** The named sets by the name effect-auth's set facts give them. `None` declares none. */
  readonly sets?: Option.Option<Readonly<Record<string, Authorization.NamedSet>>>;
}

/** A checked mapping from one effect-auth binding to one legation collection. Build it with {@link mapping}. */
export interface Mapping {
  readonly collection: string;
  readonly binding: AuthScope.Binding;
  readonly attributes: Readonly<Record<string, string>>;
  readonly sets: Readonly<Record<string, Authorization.NamedSet>>;
}

/** The scalar kind a binding attribute's literals carry: an entity reference binds as its id (text). */
const scalarKindOf = (kind: AuthScope.AttributeKind): AuthScope.ScalarKind =>
  P.isString(kind) ? kind : "Text";

/**
 * Check and build a {@link Mapping}: every binding attribute and every set
 * fact's attribute must map to a non-empty row field, the map must name no
 * attribute the binding lacks, and every set a set fact names must be
 * declared. A gap is a {@link ScopeMappingError} here, once, not per request.
 */
export const mapping = (options: MappingOptions): Result.Result<Mapping, ScopeMappingError> => {
  const { collection, binding, attributes } = options;
  const sets = Option.getOrElse(Option.flatten(Option.fromNullishOr(options.sets)), () => ({}));
  const facts = R.values(binding.setFacts ?? {});
  const required = Arr.dedupe([...R.keys(binding.attributes), ...facts.map((f) => f.attribute)]);
  const unmapped = required.filter((attribute) => {
    const field = R.get(attributes, attribute);
    return Option.isNone(field) || field.value === "";
  });
  if (Arr.isReadonlyArrayNonEmpty(unmapped)) {
    return failure(
      collection,
      "UnmappedAttribute",
      `${collection}: no row field for effect-auth attribute(s) ${unmapped.join(", ")}`
    );
  }
  const unknown = R.keys(attributes).filter((attribute) => !required.includes(attribute));
  if (Arr.isReadonlyArrayNonEmpty(unknown)) {
    return failure(
      collection,
      "UnknownAttribute",
      `${collection}: the binding declares no attribute ${unknown.join(", ")}`
    );
  }
  const undeclared = Arr.dedupe(facts.map((fact) => fact.set)).filter((set) => !R.has(sets, set));
  if (Arr.isReadonlyArrayNonEmpty(undeclared)) {
    return failure(
      collection,
      "UndeclaredSet",
      `${collection}: no NamedSet declared for set(s) ${undeclared.join(", ")}`
    );
  }
  return Result.succeed({ collection, binding, attributes, sets });
};

// ─── Literals ────────────────────────────────────────────────────────────────

/** The first instant `Date#toISOString` writes in the fixed format: `0000-01-01T00:00:00.000Z`. */
export const minInstant = -62_167_219_200_000;
/** The last instant `Date#toISOString` writes in the fixed format: `9999-12-31T23:59:59.999Z`. */
export const maxInstant = 253_402_300_799_999;

/**
 * An effect-auth scalar as a legation literal (ADR-0028 rule e), or why it has
 * none: `Text` → string, `Integer` → a safe integer, `Double` → a finite
 * number, `Boolean` → boolean, `Instant(ms)` → `new Date(ms).toISOString()`
 * for whole milliseconds in `[minInstant, maxInstant]`.
 */
export const literal = (
  collection: string,
  attribute: string,
  scalar: AuthScope.Scalar
): Result.Result<Predicate.Literal, ScopeMappingError> => {
  const outOfDomain = (what: string) =>
    failure(collection, "LiteralOutOfDomain", `${collection}.${attribute}: ${what}`);
  return Match.valueTags(scalar, {
    Text: ({ value }) =>
      P.isString(value)
        ? Result.succeed(value)
        : outOfDomain("a Text literal that is not a string"),
    Integer: ({ value }) =>
      P.isNumber(value) && Number.isSafeInteger(value)
        ? Result.succeed(value)
        : outOfDomain("an Integer literal that is not a safe integer"),
    Double: ({ value }) =>
      P.isNumber(value) && Number.isFinite(value)
        ? Result.succeed(value)
        : outOfDomain("a Double literal that is not finite"),
    Boolean: ({ value }) =>
      P.isBoolean(value) ? Result.succeed(value) : outOfDomain("a Boolean literal that is not one"),
    Instant: ({ value }) =>
      P.isNumber(value) && Number.isInteger(value) && value >= minInstant && value <= maxInstant
        ? Option.match(DateTime.make(value), {
            onSome: (instant) => Result.succeed(DateTime.formatIso(instant)),
            onNone: () => outOfDomain("an Instant that is not a valid date"),
          })
        : outOfDomain("an Instant that is not a whole millisecond in years 0000-9999"),
  });
};

// ─── Translation ─────────────────────────────────────────────────────────────

/** The row field an attribute maps to. */
const fieldOf = (map: Mapping, attribute: string): Result.Result<string, ScopeMappingError> =>
  Option.match(R.get(map.attributes, attribute), {
    onSome: (field) => Result.succeed(field),
    onNone: () =>
      failure(
        map.collection,
        "UnmappedAttribute",
        `${map.collection}: no row field for effect-auth attribute ${attribute}`
      ),
  });

/** A literal for an attribute, checked against the kind the binding declares for it. */
const literalFor = (
  map: Mapping,
  attribute: string,
  scalar: AuthScope.Scalar
): Result.Result<Predicate.Literal, ScopeMappingError> =>
  Option.match(R.get(map.binding.attributes, attribute), {
    onSome: (kind) =>
      scalarKindOf(kind) === scalar._tag
        ? literal(map.collection, attribute, scalar)
        : failure(
            map.collection,
            "LiteralKind",
            `${map.collection}.${attribute}: a ${scalar._tag} literal on a ${scalarKindOf(kind)} attribute`
          ),
    onNone: () => literal(map.collection, attribute, scalar),
  });

/**
 * A two-valued atom as a definite three-valued one: `field IS NOT NULL AND
 * atom`. On a NULL row it is false (effect-auth's answer), never unknown, so a
 * `Not` around it flips it exactly as effect-auth's does.
 */
const present = (field: string, atom: Predicate.Predicate): Predicate.Predicate =>
  Predicate.and(Predicate.isNotNull(field), atom);

/** Whether effect-auth's `matches` orders a scalar's kind: numbers only (an instant is epoch milliseconds there). */
const isOrdered = (scalar: AuthScope.Scalar): boolean =>
  Match.valueTags(scalar, {
    Integer: () => true,
    Double: () => true,
    Instant: () => true,
    Text: () => false,
    Boolean: () => false,
  });

const translatePredicate = (
  map: Mapping,
  node: AuthScope.Predicate
): Result.Result<Predicate.Predicate, ScopeMappingError> =>
  Match.valueTags(node, {
    And: ({ predicates }) =>
      Result.map(Result.all(predicates.map((inner) => translatePredicate(map, inner))), (inner) =>
        Predicate.and(...inner)
      ),
    Or: ({ predicates }) =>
      Result.map(Result.all(predicates.map((inner) => translatePredicate(map, inner))), (inner) =>
        Predicate.or(...inner)
      ),
    Not: ({ predicate }) => Result.map(translatePredicate(map, predicate), Predicate.not),
    Eq: ({ attribute, value }) =>
      Result.flatMap(fieldOf(map, attribute), (field) =>
        Result.map(literalFor(map, attribute, value), (lit) =>
          present(field, Predicate.compare("eq", field, lit))
        )
      ),
    Compare: ({ op, attribute, value }) =>
      // effect-auth's `matches` holds a `Compare` only between numbers (an
      // instant is epoch milliseconds there), so a text or boolean `Compare`
      // has no exact translation.
      isOrdered(value)
        ? Result.flatMap(fieldOf(map, attribute), (field) =>
            Result.map(literalFor(map, attribute, value), (lit) =>
              present(field, Predicate.compare(op, field, lit))
            )
          )
        : failure(
            map.collection,
            "UnmappableNode",
            `${map.collection}.${attribute}: a Compare on a ${value._tag} literal`
          ),
    IsNull: ({ attribute }) => Result.map(fieldOf(map, attribute), Predicate.isNull),
    InSet: ({ attribute, set }) =>
      Result.map(fieldOf(map, attribute), (field) => present(field, Predicate.inSet(field, set))),
  });

/**
 * Translate an effect-auth read scope into legation's, exactly, or fail with
 * the reason it cannot be. Pure: no request, no I/O.
 */
export const translate = (
  scope: AuthScope.ReadScope,
  map: Mapping
): Result.Result<Authorization.ReadScope, ScopeMappingError> =>
  Match.valueTags(scope, {
    AllowAll: () => Result.succeed(Authorization.AllowAll),
    Deny: () => Result.succeed(Authorization.Deny),
    Filter: ({ predicate }) =>
      Result.map(translatePredicate(map, predicate), (translated) =>
        Authorization.filter(translated, map.sets)
      ),
  });

/** Translate a compilation result: an `Inexact` one is a {@link ScopeMappingError}. */
export const translateCompiled = (
  compiled: AuthScope.Compiled,
  map: Mapping
): Result.Result<Authorization.ReadScope, ScopeMappingError> =>
  Match.valueTags(compiled, {
    Exact: ({ scope }) => translate(scope, map),
    Inexact: ({ reasons }) =>
      failure(map.collection, "Inexact", `${map.collection}: inexact scope: ${reasons.join("; ")}`),
  });

// ─── Auth filters ────────────────────────────────────────────────────────────

/**
 * Compile a request's read scope against a binding: what {@link toAuthFilter}
 * calls per request. {@link compiler} builds one from a policy set.
 */
export type Compile = (
  context: Backend.SyncContext,
  binding: AuthScope.Binding
) => Effect.Effect<AuthScope.Compiled, AuthorizationError>;

/** The log line for a narrowed scope: collection and reason, never the identity or a credential. */
const narrowed = (collection: string, reason: ScopeMappingReason) =>
  Effect.logWarning("legation-auth: read scope narrowed to Deny").pipe(
    Effect.annotateLogs({ collection, reason }),
    Effect.as(Authorization.Deny)
  );

/**
 * The legation auth filter for one collection: compile the request's scope
 * and translate it. Every failure narrows to `Deny` (logged): an `Inexact`
 * compilation, an untranslatable scope, and a compile that fails or dies. It
 * never fails and never answers `AllowAll` for a failure.
 */
export const toAuthFilter =
  (compile: Compile, map: Mapping): Authorization.AuthFilter =>
  (context) =>
    Effect.suspend(() => compile(context, map.binding)).pipe(
      Effect.flatMap((compiled) =>
        Result.match(translateCompiled(compiled, map), {
          onSuccess: (scope) => Effect.succeed(scope),
          onFailure: (error) => narrowed(error.collection, error.reason),
        })
      ),
      // An interrupt is not a failure to narrow: it ends the request as it is.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () => narrowed(map.collection, "CompileFailed")
      )
    );

/** What {@link compiler} compiles from, per request. */
export interface CompilerOptions {
  /** The declarative policy set for the request (static, or read from a policy store). */
  readonly policies: (
    context: Backend.SyncContext
  ) => Effect.Effect<ReadonlyArray<Policy.DeclarativePolicy>, AuthorizationError>;
  /**
   * The effect-auth request a scope is compiled for — the principal's entity
   * ref, the action and the principal's slice — from the request's
   * {@link Principal.Principal} (anonymous when it has none).
   */
  readonly request: (
    principal: Principal.Principal,
    context: Backend.SyncContext
  ) => Effect.Effect<AuthScope.ScopeRequest, AuthorizationError>;
}

/** A {@link Compile} over effect-auth's `ReadScope.compile`. */
export const compiler =
  (options: CompilerOptions): Compile =>
  (context, binding) =>
    options
      .policies(context)
      .pipe(
        Effect.flatMap((policies) =>
          Effect.map(options.request(Principal.fromContext(context), context), (request) =>
            AuthScope.compile(policies, binding, request)
          )
        )
      );

/** One collection's scope for {@link policy}: its mapping and how its scope is compiled. */
export interface ScopedCollection extends Omit<MappingOptions, "collection"> {
  readonly compile: Compile;
}

/** Options for {@link policy}. */
export interface PolicyOptions {
  /** Auth filters for collections effect-auth does not scope (a public collection's `allowAll`). */
  readonly filters?: Option.Option<Readonly<Record<string, Authorization.AuthFilter>>>;
  /** The collection registry whose filterable sets the policy enforces (`Authorization.policy`'s `collections`). */
  readonly collections?: Option.Option<Collection.CollectionRegistry>;
}

/**
 * Build the `AuthPolicy` from effect-auth-scoped collections, checking every
 * mapping now. Only the listed collections (and `options.filters`) get a
 * filter: any other collection stays unreachable, as `Authorization.policy`
 * denies by default.
 */
export const policy = (
  collections: Readonly<Record<string, ScopedCollection>>,
  options?: PolicyOptions
): Result.Result<Authorization.AuthPolicy, ScopeMappingError> =>
  Result.map(
    Result.all(
      R.map(collections, (scoped, collection) =>
        Result.map(
          mapping({
            collection,
            binding: scoped.binding,
            attributes: scoped.attributes,
            sets: scoped.sets ?? Option.none(),
          }),
          (map) => toAuthFilter(scoped.compile, map)
        )
      )
    ),
    (scopedFilters) => {
      const filters = {
        ...Option.getOrElse(Option.flatten(Option.fromNullishOr(options?.filters)), () => ({})),
        ...scopedFilters,
      };
      return Option.match(Option.flatten(Option.fromNullishOr(options?.collections)), {
        onNone: () => Authorization.policy(filters),
        onSome: (registry) => Authorization.policy(filters, { collections: registry }),
      });
    }
  );
