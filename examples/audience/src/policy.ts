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
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Condition, Entity, Policy } from "@thomasfosterau/effect-auth";
import { type Authorization, type Backend, Predicate } from "@thomasfosterau/legation";
import { ReadScopes } from "@thomasfosterau/legation-auth";
import { FOLLOWS, nodes, posts } from "./domain.js";

/** The role that reads everything. */
export const MODERATOR = "moderator";

/** The action every read is decided for. */
export const readAction = Entity.ref("Action", "read");

/**
 * What a `Post` is to effect-auth, derived from the `posts` node: `owner` is
 * a `User` reference held in `ownerId`, `visibility` takes the node's own
 * kind (text), and `followsOwner` is the set fact the followers rule names. A
 * field the node lacks or a kind it cannot carry fails here, at import.
 */
export const postsBinding: ReadScopes.NodeBinding = Result.getOrThrow(
  ReadScopes.bindingOf(posts, {
    resourceType: "Post",
    attributes: { owner: { field: "ownerId", entity: "User" }, visibility: "visibility" },
    setFacts: { followsOwner: { attribute: "owner", set: "following" } },
  })
);

/** The effect-auth binding the policy set is compiled against. */
export const binding = postsBinding.binding;

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

/**
 * The effect-auth request a principal's scope is compiled for: `User::<id>`
 * (`User::""` when anonymous), the read action, and the user under its role
 * (`user.attributes.role`), so `Policy.role` can see it.
 */
export const readRequest = ReadScopes.principalRequest({ action: readAction });

/**
 * The `following` named set: the users the request's principal follows, the
 * `followeeId`s of its `follows` rows (none for an anonymous viewer).
 * Resolved per pull and re-resolved when `follows` changes, so a follow
 * moves the set's members without changing any subscription's scope.
 */
export const following = (backend: Backend.Backend): Authorization.NamedSet =>
  ReadScopes.userSet(backend, {
    source: FOLLOWS,
    where: (userId) => Predicate.eq("followerId", userId),
    member: "followeeId",
    maxAge: "1 hour",
  });

/** The read policy over the backend: `posts` scoped by effect-auth, every other collection denied. */
export const authPolicy = (backend: Backend.Backend): Authorization.AuthPolicy =>
  Result.getOrThrow(
    ReadScopes.policy(
      {
        posts: {
          ...postsBinding,
          sets: { following: following(backend) },
          compile: ReadScopes.compiler({
            policies: () => Effect.succeed(policies),
            request: readRequest,
          }),
        },
      },
      { collections: nodes.collections }
    )
  );
