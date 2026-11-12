/**
 * Who may read which post, written once, as effect-auth policies, and
 * compiled per request into the subscription's auth filter by
 * `@thomasfosterau/legation-auth`'s `ReadScopes`.
 *
 * The policy set covers the three shapes a read scope takes:
 *
 * - **a real predicate** — `visibility = "public"`, or the viewer's own posts,
 *   or `visibility = "followers"` when the owner is in the viewer's
 *   `following` set (a **named set**: the relationship-scoped case, ADR-0015);
 * - **`AllowAll`** — the moderator role short-circuits: effect-auth compiles
 *   the whole set to `AllowAll`, and no predicate is AND-ed in at all;
 * - **`Deny`** — what any scope narrows to when it cannot be translated
 *   exactly (never exercised by a well-formed set like this one, but the
 *   bridge's fail-closed answer).
 *
 * An anonymous viewer is `User::""`, which no policy names: the public posts.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import {
  Condition,
  Entity,
  Policy,
  Rbac,
  type ReadScope as AuthScope,
} from "@thomasfosterau/effect-auth";
import {
  type Authorization,
  AuthorizationError,
  type Backend,
  Predicate,
} from "@thomasfosterau/legation";
import { Subset } from "@thomasfosterau/legation/internal";
import { Principal, ReadScopes } from "@thomasfosterau/legation-auth";
import { FOLLOWS, type Follow, nodes } from "./domain.js";

/** The role that reads everything. */
export const MODERATOR = "moderator";

/** The action every read is decided for. */
export const readAction = Entity.ref("Action", "read");

/**
 * What a `Post` is to effect-auth's compiler: the attributes a policy may
 * read, and the set fact the followers rule names.
 */
export const binding: AuthScope.Binding = {
  resourceType: "Post",
  attributes: { owner: { entity: "User" }, visibility: "Text" },
  setFacts: { followsOwner: { attribute: "owner", set: "following" } },
};

/**
 * effect-auth attribute → the `posts` row field it lives in (a to-one entity
 * maps to its key). (Hand-written glue: this and {@link binding} restate the
 * `posts` node's schema.)
 */
export const attributes = { owner: "ownerId", visibility: "visibility" } as const;

const resource = (name: string) => Condition.attr("resource", name);

/** The policy set: public posts, one's own, followers-only posts of people one follows; moderators read all. */
export const policies: ReadonlyArray<Policy.DeclarativePolicy> = [
  Policy.permit({
    id: "public",
    resource: Policy.isType("Post"),
    when: Condition.eq(resource("visibility"), Condition.lit("public")),
  }),
  Policy.permit({
    id: "own",
    resource: Policy.isType("Post"),
    when: Condition.eq(resource("owner"), Condition.principal),
  }),
  Policy.permit({
    id: "followers",
    resource: Policy.isType("Post"),
    when: Condition.and(
      Condition.eq(resource("visibility"), Condition.lit("followers")),
      Condition.eq(Condition.attr("context", "followsOwner"), Condition.lit(true))
    ),
  }),
  Policy.role(MODERATOR, { id: "moderator" }),
];

/** The role a principal's user carries (`attributes.role`, where effect-auth's fixtures put it). */
const roleOf = (principal: Principal.Principal): Option.Option<string> =>
  P.isTagged(principal, "Session")
    ? Option.filter(Option.fromNullishOr(principal.user.attributes["role"]), P.isString)
    : Option.none();

/**
 * The effect-auth request a principal's scope is compiled for: `User::<id>`
 * (`User::""` when anonymous), the read action, and the slice that puts the
 * user under its role, so `Policy.role` can see it. (Hand-written glue:
 * `ReadScopes.compiler` leaves this projection to every app.)
 */
export const scopeRequest = (principal: Principal.Principal): AuthScope.ScopeRequest => {
  const user = Entity.ref(
    "User",
    Option.getOrElse(Principal.userId(principal), () => "")
  );
  return {
    principal: user,
    action: readAction,
    slice: Entity.slice([
      Entity.entity(user, { parents: Option.toArray(Option.map(roleOf(principal), Rbac.roleRef)) }),
    ]),
  };
};

/** The followees of `userId`, from the server's `follows` collection. */
export const followeesOf = (
  backend: Backend.Backend,
  context: Backend.SyncContext,
  userId: string
): Effect.Effect<ReadonlyArray<string>, AuthorizationError> =>
  Effect.gen(function* () {
    const entries = yield* backend.evaluate(
      context,
      Subset.make({ collection: FOLLOWS, where: Predicate.eq("followerId", userId) })
    );
    const rows = yield* backend.getRows(
      context,
      FOLLOWS,
      Arr.map(entries, (entry) => entry.id)
    );
    return Arr.map(rows, (row) => (row.value as Follow).followeeId);
  }).pipe(
    Effect.mapError(
      (error) => new AuthorizationError({ message: error.message, collection: FOLLOWS })
    )
  );

/**
 * The `following` named set: the users the request's principal follows.
 * Resolved per pull and re-resolved when `follows` changes, so a follow
 * moves the set's members without changing any subscription's scope.
 * (Hand-written glue: no named-set constructor reads a backend collection.)
 */
export const following = (backend: Backend.Backend): Authorization.NamedSet => ({
  source: FOLLOWS,
  maxAge: "1 hour",
  resolve: (context) =>
    Option.match(Principal.userId(Principal.fromContext(context)), {
      onNone: () => Effect.succeed([]),
      onSome: (userId) => followeesOf(backend, context, userId),
    }),
});

/** The read policy over the backend: `posts` scoped by effect-auth, every other collection denied. */
export const authPolicy = (backend: Backend.Backend): Authorization.AuthPolicy =>
  Result.getOrThrow(
    ReadScopes.policy(
      {
        posts: {
          binding,
          attributes,
          sets: Option.some({ following: following(backend) }),
          compile: ReadScopes.compiler({
            policies: () => Effect.succeed(policies),
            request: (principal) => Effect.succeed(scopeRequest(principal)),
          }),
        },
      },
      { collections: Option.some(nodes.collections) }
    )
  );
