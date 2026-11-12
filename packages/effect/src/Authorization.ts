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

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Str from "effect/String";
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
export const scopeOf = (output: ReadScope | Predicate): ReadScope =>
  isReadScope(output) ? output : filter(output);

/** Whether a filter's output is a {@link ReadScope} rather than a bare predicate. */
const isReadScope = (output: ReadScope | Predicate): output is ReadScope =>
  P.isTagged(output, "AllowAll") || P.isTagged(output, "Deny") || P.isTagged(output, "Filter");

/**
 * How {@link authorize} binds a named set for one request: the members, or
 * `Option.none()` when the set cannot be resolved, which narrows. The sync
 * server passes one that caches per session and records what it bound, for the
 * scope epoch; the default resolves each set afresh.
 */
export type SetBinder = (
  context: SyncContext,
  collection: string,
  name: string,
  set: NamedSet
) => Effect.Effect<Option.Option<ReadonlyArray<Predicates.Literal>>>;

/** Resolve a set afresh, binding nothing when its resolver fails. */
export const resolveSet: SetBinder = (context, _collection, _name, set) =>
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
export const AuthPolicy = Context.Service<AuthPolicy>("@thomasfosterau/legation/AuthPolicy");

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
      return Match.valueTags(scopeOf(output), {
        AllowAll: () => Effect.succeed(subset),
        Deny: () => Effect.succeed({ ...subset, where: Predicates.isIn("id", []) }),
        Filter: (scope) =>
          bindScope(scope, context, subset.collection, bindSet).pipe(
            Effect.map((mandatory) => ({
              ...subset,
              where: Predicates.and(mandatory, subset.where),
            }))
          ),
      });
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
  collection: string,
  bindSet: SetBinder
): Effect.Effect<Predicate> =>
  Effect.forEach(
    Predicates.setNames(scope.predicate),
    (name) => {
      const set = scope.sets[name];
      return set === undefined
        ? Effect.succeed([name, Option.none()] as const)
        : bindSet(context, collection, name, set).pipe(
            Effect.map((values) => [name, values] as const)
          );
    },
    { concurrency: 1 }
  ).pipe(
    Effect.map((entries) =>
      Predicates.bindSets(
        scope.predicate,
        HashMap.fromIterable(
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
  "@thomasfosterau/legation/SyncMiddleware"
);

/** The identity middleware (no interception). */
export const passthroughMiddleware: SyncMiddleware = {
  onPush: (_context, request) => Effect.succeed(request),
  onPull: (_context, request) => Effect.succeed(request),
  onRead: (_context, request) => Effect.succeed(request),
};

/**
 * An opaque, read-only view of the credential-bearing headers of the transport
 * request a push, pull or read arrived on (ADR-0035): what an
 * {@link IdentityResolver} verifies a session cookie or an API key from.
 *
 * Only the resolver sees it. It never reaches `SyncContext`, middleware, auth
 * filters, logs, spans or errors, and it offers no way to list its headers: a
 * resolver asks for the header it verifies by name. Its values live in a
 * closure, so serialising or inspecting it shows none of them.
 */
export interface RequestCredentials {
  /**
   * The value of the named request header, or `None` when the request did not
   * carry it. The lookup is case-insensitive; a header the request repeated is
   * one value, its parts joined as HTTP joins them (`; ` for `cookie`, `, `
   * otherwise).
   */
  readonly header: (name: string) => Option.Option<string>;
}

/**
 * The header shapes {@link credentialsFromHeaders} accepts: a WHATWG `Headers`
 * (or any iterable of `[name, value]` pairs) and a plain record of names to
 * values, such as `effect/http`'s `Headers`.
 */
export type CredentialHeaders =
  | Iterable<readonly [string, string]>
  | Readonly<Record<string, string>>;

/** How a repeated header's parts are joined: cookies by `; `, everything else by `, `. */
const joinerOf = (name: string): string => (name === "cookie" ? "; " : ", ");

/** What a {@link RequestCredentials} prints as, wherever it is logged or serialised by mistake. */
const redacted = (): string => "RequestCredentials(<redacted>)";

/** A {@link RequestCredentials} over an already lowercased header map. */
const credentialsOf = (headers: HashMap.HashMap<string, string>): RequestCredentials => {
  const header = (name: string): Option.Option<string> =>
    HashMap.get(headers, Str.toLowerCase(name));
  const credentials = { header, toJSON: redacted, toString: redacted };
  return credentials;
};

/**
 * Build {@link RequestCredentials} from a transport request's headers. Names are
 * lowercased once, here; a name given more than once (two pairs, or two record
 * keys that differ only in case) keeps every part, joined as HTTP joins a
 * repeated field. The headers are copied, so later changes to `headers` are not
 * seen.
 */
export const credentialsFromHeaders = (headers: CredentialHeaders): RequestCredentials =>
  credentialsOf(
    Arr.reduce(
      P.isIterable(headers) ? Arr.fromIterable(headers) : R.toEntries(headers),
      HashMap.empty<string, string>(),
      (collected, [rawName, value]) => {
        const name = Str.toLowerCase(rawName);
        return HashMap.set(
          collected,
          name,
          Option.match(HashMap.get(collected, name), {
            onNone: () => value,
            onSome: (existing) => `${existing}${joinerOf(name)}${value}`,
          })
        );
      }
    )
  );

/**
 * The {@link RequestCredentials} of a request that carried none: every header is
 * absent. A carrier with no transport request (the in-memory loopback, an SSR
 * render in the same process, a test) passes it.
 */
export const noCredentials: RequestCredentials = credentialsOf(HashMap.empty());

/**
 * What an {@link IdentityResolver} resolves an identity from: the client group
 * the request names and the {@link RequestCredentials} its transport request
 * carried.
 */
export interface IdentityRequest {
  /** The client group the push, pull or read names. It is client-chosen: never an identity on its own. */
  readonly clientGroupId: string;
  /** The transport request's credential-bearing headers; {@link noCredentials} when it had none. */
  readonly credentials: RequestCredentials;
}

/**
 * Resolve a request's identity — the decoded, never-client-forgeable principal
 * the auth filters and middleware see on `SyncContext.identity` — from the
 * request's credentials and client group (ADR-0015's identity seam, widened by
 * ADR-0035).
 *
 * The sync server calls it once per push, pull and read. A carrier that has a
 * transport request passes its headers (`Transport.HandleOptions.credentials`);
 * one with no request (the in-memory loopback, tests) passes
 * {@link noCredentials}. The resolver alone sees the credentials: `SyncContext`
 * carries only the identity it returns, so verify them here (a signed session
 * cookie, an API key) and return nothing derived from their raw value.
 *
 * A failing `resolve` fails the request with its `AuthorizationError`, which
 * reaches the client: never put a credential in its message. A resolver that
 * wants to fail closed to anonymous returns its anonymous identity (for
 * example `undefined`) instead of failing. Optional: absent ⇒ `identity` stays
 * `undefined` (public/deny-by-default).
 */
export interface IdentityResolver {
  readonly resolve: (request: IdentityRequest) => Effect.Effect<unknown, AuthorizationError>;
}

/** The {@link IdentityResolver} service; absent leaves `SyncContext.identity` undefined. */
export const IdentityResolver = Context.Service<IdentityResolver>(
  "@thomasfosterau/legation/IdentityResolver"
);

/**
 * The `SyncContext` a request runs under: the client group it names and the
 * identity `resolver` resolves from its credentials (ADR-0035). With no
 * resolver the identity stays `undefined` (anonymous). The credentials go to
 * the resolver and nowhere else: the context carries the group and the
 * resolved identity only. A failing resolver fails with its
 * `AuthorizationError`.
 *
 * Every carrier builds its context this way: the sync server for each push,
 * pull and read, and an HTTP handler outside the sync protocol (the JSON:API
 * tier's `RestHandlers`) from its own request's headers.
 */
export const resolveContext = (
  resolver: Option.Option<IdentityResolver>,
  request: IdentityRequest
): Effect.Effect<SyncContext, AuthorizationError> =>
  Option.match(resolver, {
    onNone: () => Effect.succeed({ clientGroupId: request.clientGroupId }),
    onSome: (identityResolver) =>
      identityResolver
        .resolve(request)
        .pipe(Effect.map((identity) => ({ clientGroupId: request.clientGroupId, identity }))),
  });
