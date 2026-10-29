/**
 * Authorization
 *
 * Read authorization for collection-subset subscriptions: deny by default.
 * Every collection a server exposes must declare an auth filter — a
 * function from the request's SyncContext to a predicate that is AND-ed
 * into every client subscription before evaluation, so client predicates
 * can only narrow the authorized set. Write authorization is plain code
 * inside backend mutators.
 *
 * Before the auth filter is AND-ed in, a client-authored subset is checked
 * against its collection's **filterable set** (FilterPolicy.ts, ADR-0028
 * rule d, #154): every field it filters or sorts by must be declared with
 * that operator and a literal of the declared kind, and `Exists` is refused
 * outright. The auth filter's own predicate and server-resolved named
 * queries are server-authored and exempt.
 *
 * Cross-cutting concerns (tenancy, cost control, telemetry) attach via
 * SyncMiddleware, which can rewrite or reject requests around the core
 * push/pull handling.
 */

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AuthorizationError } from "./Errors.js";
import type { SyncContext } from "./Backend.js";
import * as Collection from "./Collection.js";
import * as FilterPolicy from "./FilterPolicy.js";
import type { Predicate } from "./Predicate.js";
import * as Predicates from "./Predicate.js";
import type { PullRequest, PushRequest, ReadRequest } from "./Protocol.js";
import type { Subset } from "./Subset.js";

/**
 * A named, session-resolved set an auth filter's predicate refers to by name
 * (`Predicate.inSet(field, name)`, ADR-0015's #205 amendment): the viewer's
 * following ids, the tenants they belong to. The name, not the members, is
 * part of the predicate, so a subscription keeps its identity while the set
 * moves.
 */
export interface NamedSet {
  /**
   * The collection the set is computed from. A committed write to it marks the
   * set stale for every session that resolved it and pokes those sessions, so
   * their next pull resolves it again.
   */
  readonly source: string;
  /**
   * Resolve the set's members for the request's identity. A failure binds the
   * set to nothing: an unresolvable set narrows, never widens (rule 5).
   */
  readonly resolve: (
    context: SyncContext
  ) => Effect.Effect<ReadonlyArray<Predicates.Literal>, AuthorizationError>;
  /**
   * The safety net under droppable hints: a set resolved longer ago than this is
   * resolved again on the next pull, even with no write to its source.
   */
  readonly maxAge: Duration.Input;
}

/**
 * What an auth filter decides for a request (ADR-0015's #205 amendment, the
 * same shape as effect-auth's compiled read scope): every row of the collection
 * (`AllowAll`, the role short-circuit), none of them (`Deny`), or the rows a
 * predicate admits (`Filter`), which may refer to named sets by name.
 */
export type ReadScope =
  | { readonly _tag: "AllowAll" }
  | { readonly _tag: "Deny" }
  | {
      readonly _tag: "Filter";
      readonly predicate: Predicate;
      readonly sets: Readonly<Record<string, NamedSet>>;
    };

/** The {@link ReadScope} that admits every row. */
export const AllowAll: ReadScope = { _tag: "AllowAll" };

/** The {@link ReadScope} that admits no row. */
export const Deny: ReadScope = { _tag: "Deny" };

/**
 * The {@link ReadScope} admitting the rows `predicate` matches, with the named
 * sets its `inSet` nodes refer to. A name the predicate uses that `sets` does
 * not declare binds to nothing.
 */
export const filter = (
  predicate: Predicate,
  sets: Readonly<Record<string, NamedSet>> = {}
): ReadScope => ({ _tag: "Filter", predicate, sets });

/**
 * Produce a collection's read scope, per request. A bare `Predicate` is a
 * `Filter` without named sets (the pre-#205 form, still accepted).
 */
export type AuthFilter = (
  context: SyncContext
) => Effect.Effect<ReadScope | Predicate, AuthorizationError>;

/**
 * Allow every row (public collection): a filter that returns `AllowAll`. It
 * must be declared for the collection; an undeclared collection stays denied.
 */
export const allowAll: AuthFilter = () => Effect.succeed(AllowAll);

/** The scope a filter's output stands for: a bare predicate is a `Filter` without sets. */
export const scopeOf = (output: ReadScope | Predicate): ReadScope => {
  switch (output._tag) {
    case "AllowAll":
    case "Deny":
    case "Filter":
      return output;
    default:
      return filter(output);
  }
};

/**
 * How {@link authorize} binds a named set for one request: the members, or
 * `Option.none()` when the set cannot be resolved, which narrows. The sync
 * server passes one that caches per session and records what it bound, for the
 * scope epoch; the default resolves each set afresh.
 */
export type SetBinder = (
  context: SyncContext,
  name: string,
  set: NamedSet
) => Effect.Effect<Option.Option<ReadonlyArray<Predicates.Literal>>>;

/** Resolve a set afresh, binding nothing when its resolver fails. */
export const resolveSet: SetBinder = (context, _name, set) =>
  set.resolve(context).pipe(Effect.option);

/** Per-collection auth filters. Subscribing to an unlisted collection fails. */
export interface AuthPolicy {
  readonly filters: ReadonlyMap<string, AuthFilter>;
  /**
   * The filterable set per collection (#154), from the collection registry
   * the policy was built with. When present, every client-authored subset
   * is checked against its collection's declaration — a collection the
   * registry does not know gets {@link FilterPolicy.bare} (`id` by `eq` /
   * `in`, sortable by `id`). Absent (a policy built without `collections`),
   * the filter surface is not enforced: the pre-#154 open behaviour, kept
   * for policies that never see a Node graph.
   */
  readonly declarations?: ReadonlyMap<string, FilterPolicy.FilterDeclaration>;
}

/** The {@link AuthPolicy} service the sync server authorizes every request against. */
export const AuthPolicy = Context.Service<AuthPolicy>("@thomasfosterau/legation-effect/AuthPolicy");

/** Options for {@link policy}. */
export interface PolicyOptions {
  /**
   * The collection registry (`Node.registry(...).collections`) whose
   * `filterable` / `sortable` declarations `authorize` enforces. Pass it:
   * without it, nothing bounds what a client may filter or sort by.
   */
  readonly collections?: Collection.CollectionRegistry;
}

/**
 * Build an {@link AuthPolicy} from per-collection filters; unlisted collections are denied.
 * Pass `options.collections` so the collections' filterable sets are enforced too.
 */
export const policy = (
  filters: Readonly<Record<string, AuthFilter>>,
  options?: PolicyOptions
): AuthPolicy => ({
  filters: new Map(Object.entries(filters)),
  ...(options?.collections === undefined
    ? {}
    : {
        declarations: new Map(
          [...options.collections.values()].map(
            (collection) => [collection.name, Collection.filterDeclarationOf(collection)] as const
          )
        ),
      }),
});

/**
 * Who authored a subset. A `"client"` subset came off the wire and is
 * checked against the filterable set; a `"server"` subset (a named-query
 * resolver's output) is trusted and only narrowed by the auth filter.
 */
export type SubsetOrigin = "client" | "server";

/**
 * Admit a client subset's `where` / `orderBy` against its collection's
 * filterable set, or fail naming the collection, field and operator.
 * A no-op for a policy without declarations.
 */
export const checkFilterable = (
  authPolicy: AuthPolicy,
  subset: Subset
): Effect.Effect<void, AuthorizationError> => {
  if (authPolicy.declarations === undefined) return Effect.void;
  const declaration = authPolicy.declarations.get(subset.collection) ?? FilterPolicy.bare;
  const failure = FilterPolicy.check(subset.collection, declaration, subset);
  return failure === undefined ? Effect.void : Effect.fail(failure);
};

/**
 * Narrow a subset with its collection's auth filter (deny by default). A
 * `"client"` subset is first checked against the filterable set (#154) —
 * before the filter runs, so nothing undeclared reaches `Backend.evaluate`.
 */
export const authorize = (
  authPolicy: AuthPolicy,
  context: SyncContext,
  subset: Subset,
  origin: SubsetOrigin = "client",
  bindSet: SetBinder = resolveSet
): Effect.Effect<Subset, AuthorizationError> => {
  const declared = authPolicy.filters.get(subset.collection);
  if (declared === undefined) {
    return Effect.fail(
      new AuthorizationError({
        message: `No auth filter declared for collection "${subset.collection}" (deny by default)`,
        collection: subset.collection,
      })
    );
  }
  const admitted = origin === "client" ? checkFilterable(authPolicy, subset) : Effect.void;
  return admitted.pipe(
    Effect.andThen(declared(context)),
    Effect.flatMap((output) => {
      const scope = scopeOf(output);
      switch (scope._tag) {
        case "AllowAll":
          return Effect.succeed(subset);
        case "Deny":
          return Effect.succeed({ ...subset, where: Predicates.isIn("id", []) });
        case "Filter":
          return bindScope(scope, context, bindSet).pipe(
            Effect.map((mandatory) => ({
              ...subset,
              where: Predicates.and(mandatory, subset.where),
            }))
          );
      }
    })
  );
};

/**
 * A `Filter` scope's predicate with every named set bound to its members. A
 * set the predicate names that the scope does not declare, or that the binder
 * cannot resolve, is left unbound, and `Predicate.bindSets` makes an unbound
 * set narrow: its branch admits no row (rule 5).
 */
const bindScope = (
  scope: Extract<ReadScope, { readonly _tag: "Filter" }>,
  context: SyncContext,
  bindSet: SetBinder
): Effect.Effect<Predicate> =>
  Effect.forEach(
    [...Predicates.setNames(scope.predicate)],
    (name) => {
      const set = scope.sets[name];
      return set === undefined
        ? Effect.succeed([name, Option.none()] as const)
        : bindSet(context, name, set).pipe(Effect.map((values) => [name, values] as const));
    },
    { concurrency: 1 }
  ).pipe(
    Effect.map((entries) =>
      Predicates.bindSets(
        scope.predicate,
        new Map(
          entries.flatMap(([name, values]) => Option.toArray(values).map((v) => [name, v] as const))
        )
      )
    )
  );

/** Interception seam around push/pull/read handling. */
export interface SyncMiddleware {
  readonly onPush: (
    context: SyncContext,
    request: PushRequest
  ) => Effect.Effect<PushRequest, AuthorizationError>;
  readonly onPull: (
    context: SyncContext,
    request: PullRequest
  ) => Effect.Effect<PullRequest, AuthorizationError>;
  /**
   * Around fallthrough reads (ADR-0025). Optional — absent means
   * passthrough — so middleware written before the read tier keeps working.
   */
  readonly onRead?: (
    context: SyncContext,
    request: ReadRequest
  ) => Effect.Effect<ReadRequest, AuthorizationError>;
}

/** The {@link SyncMiddleware} service; absent means {@link passthroughMiddleware}. */
export const SyncMiddleware = Context.Service<SyncMiddleware>(
  "@thomasfosterau/legation-effect/SyncMiddleware"
);

/** The identity middleware (no interception). */
export const passthroughMiddleware: SyncMiddleware = {
  onPush: (_context, request) => Effect.succeed(request),
  onPull: (_context, request) => Effect.succeed(request),
  onRead: (_context, request) => Effect.succeed(request),
};

/**
 * Resolve the request's identity for a connected client group — the decoded,
 * never-client-forgeable principal the auth filters and middleware see on
 * `SyncContext.identity`. A real carrier derives it from the authenticated
 * connection (a verified token); the resolver is the seam where that lands.
 * Optional: absent ⇒ `identity` stays `undefined` (public/deny-by-default).
 */
export interface IdentityResolver {
  readonly resolve: (clientGroupId: string) => Effect.Effect<unknown, AuthorizationError>;
}

/** The {@link IdentityResolver} service; absent leaves `SyncContext.identity` undefined. */
export const IdentityResolver = Context.Service<IdentityResolver>(
  "@thomasfosterau/legation-effect/IdentityResolver"
);
