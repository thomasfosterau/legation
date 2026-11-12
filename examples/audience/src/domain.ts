/**
 * The audience domain, shared by both sides: one node (`posts`), the
 * mutations that write it and the follow graph, and the reads the tests pin.
 *
 * A post has an **owner** and a **visibility** on a three-state axis:
 *
 * - `public` — anyone may read it, signed in or not;
 * - `followers` — its owner, and the people who follow its owner;
 * - `private` — its owner alone.
 *
 * A **moderator** reads everything. None of that is written here: it is the
 * effect-auth policy set in `policy.ts`, compiled per request into the
 * subscription's auth filter. The client never sees the follow graph — it is
 * a server-side collection (`follows`) that no node declares and no auth
 * filter admits, read only by the named set the policy refers to.
 */
import * as Schema from "effect/Schema";
import { Mutation, Node, type Query } from "@thomasfosterau/legation";

// ─── Rows ────────────────────────────────────────────────────────────────────

/** The visibility axis. */
export const Visibility = Schema.Literals(["public", "followers", "private"]);
export type Visibility = typeof Visibility.Type;

export const PostSchema = Schema.Struct({
  id: Schema.String,
  /** The effect-auth user id of the author: server-checked on every write. */
  ownerId: Schema.String,
  visibility: Visibility,
  body: Schema.String,
});
export type Post = typeof PostSchema.Type;

/** One edge of the follow graph: `followerId` follows `followeeId`. */
export const FollowSchema = Schema.Struct({
  followerId: Schema.String,
  followeeId: Schema.String,
});
export type Follow = typeof FollowSchema.Type;

/** The `follows` row id of an edge. */
export const followId = (follow: Follow): string => `${follow.followerId}->${follow.followeeId}`;

// ─── The node graph (ADR-0022) ───────────────────────────────────────────────

const { id: _id, ...postAttributes } = PostSchema.fields;

/**
 * `posts`: filterable by owner and visibility (the façade's URLs use both),
 * and by `id`, the identity default.
 */
export const posts = Node.make("posts", {
  attributes: postAttributes,
  filterable: { ownerId: ["eq"], visibility: ["eq"] },
  hintKeys: ["ownerId"],
});

export const nodes = Node.registry([posts]);

/** The server-side collection the `following` named set is computed from. Not a node. */
export const FOLLOWS = "follows";

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Publish or edit a post. The server accepts it only from the post's owner. */
export const putPost = Mutation.make("post/put", PostSchema);
/** Follow someone. The server accepts it only from the follower. */
export const follow = Mutation.make("follow/add", FollowSchema);
/** Stop following someone. The server accepts it only from the follower. */
export const unfollow = Mutation.make("follow/remove", FollowSchema);

/** The client's optimistic handlers: a post lands in the overlay before any round trip. */
export const mutations = Mutation.registry([
  { mutator: putPost, local: (post, writer) => writer.put("posts", post.id, post) },
]);

// ─── Reads ───────────────────────────────────────────────────────────────────
//
// Plain literals declared `as const satisfies Query.Read`: the shape is checked
// here, and the literal collection types the rows a typed Client answers.

/** Every post the viewer may read: the one pin each test's replica holds. */
export const feed = { collection: "posts" } as const satisfies Query.Read;

/** One author's posts, as far as the viewer may read them. */
export const byOwner = (ownerId: string) => ({
  collection: "posts",
  where: { ownerId },
}) as const satisfies Query.Read;

/** The posts of one visibility, as far as the viewer may read them. */
export const byVisibility = (visibility: Visibility) => ({
  collection: "posts",
  where: { visibility },
}) as const satisfies Query.Read;
