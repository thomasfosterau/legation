/**
 * Domain — RealWorld (Conduit)
 *
 * The shared sync vocabulary for a Medium-style blogging app, defined once and
 * used on both sides of the engine (CONTEXT.md). Conduit is relational, so this
 * models several independent collections joined client-side over the mirror:
 *
 *   users      — accounts/profiles (username is the row id)
 *   articles   — posts (slug is the row id; authorId references users)
 *   comments   — article comments (articleSlug references articles)
 *   favorites  — a user⇄article join row (`${userId}:${slug}`)
 *   follows    — a follower⇄followee join row (`${followerId}:${followeeId}`)
 *
 * Reads are public (allow-all auth); writes are *named, schema-validated
 * mutators* run optimistically on the client and authoritatively on the demo
 * backend, which enforces ownership against the request identity (see
 * `sync.ts`). Counts (favoritesCount) and flags (favorited, following) are
 * derived from the join collections on the client, never denormalised onto the
 * row — so a rebase can never leave a stale counter.
 */

import { Schema } from "effect";
import { Collection, Mutator, Subset } from "@legation/effect";

// ─── Row schemas ─────────────────────────────────────────────────────────────

export const User = Schema.Struct({
  /** Row id. Conduit identifies users by username. */
  username: Schema.String,
  email: Schema.String,
  /** Demo-only plaintext password (never do this for real). */
  password: Schema.String,
  bio: Schema.String,
  image: Schema.String,
});
export type User = typeof User.Type;

export const Article = Schema.Struct({
  /** Row id, derived from the title. */
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  body: Schema.String,
  tagList: Schema.Array(Schema.String),
  /** References `users.username`. */
  authorId: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type Article = typeof Article.Type;

export const Comment = Schema.Struct({
  id: Schema.String,
  /** References `articles.slug`. */
  articleSlug: Schema.String,
  /** References `users.username`. */
  authorId: Schema.String,
  body: Schema.String,
  createdAt: Schema.Number,
});
export type Comment = typeof Comment.Type;

export const Favorite = Schema.Struct({
  /** Row id: `${userId}:${articleSlug}`. */
  id: Schema.String,
  userId: Schema.String,
  articleSlug: Schema.String,
});
export type Favorite = typeof Favorite.Type;

export const Follow = Schema.Struct({
  /** Row id: `${followerId}:${followeeId}`. */
  id: Schema.String,
  followerId: Schema.String,
  followeeId: Schema.String,
});
export type Follow = typeof Follow.Type;

// ─── Collections ─────────────────────────────────────────────────────────────

export const usersCollection = Collection.make({
  name: "users",
  schema: User,
  id: (user) => user.username,
});
export const articlesCollection = Collection.make({
  name: "articles",
  schema: Article,
  id: (article) => article.slug,
});
export const commentsCollection = Collection.make({
  name: "comments",
  schema: Comment,
  id: (comment) => comment.id,
});
export const favoritesCollection = Collection.make({
  name: "favorites",
  schema: Favorite,
  id: (favorite) => favorite.id,
});
export const followsCollection = Collection.make({
  name: "follows",
  schema: Follow,
  id: (follow) => follow.id,
});

// ─── Mutator arg schemas ─────────────────────────────────────────────────────

export const RegisterArgs = Schema.Struct({
  username: Schema.String,
  email: Schema.String,
  password: Schema.String,
});
export const UpdateUserArgs = Schema.Struct({
  username: Schema.String,
  email: Schema.String,
  password: Schema.String,
  bio: Schema.String,
  image: Schema.String,
});
export const ArticleInput = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  body: Schema.String,
  tagList: Schema.Array(Schema.String),
  authorId: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export const SlugArgs = Schema.Struct({ slug: Schema.String });
export const FavoriteArgs = Schema.Struct({ userId: Schema.String, articleSlug: Schema.String });
export const FollowArgs = Schema.Struct({ followerId: Schema.String, followeeId: Schema.String });
export const AddCommentArgs = Schema.Struct({
  id: Schema.String,
  articleSlug: Schema.String,
  authorId: Schema.String,
  body: Schema.String,
  createdAt: Schema.Number,
});
export const CommentIdArgs = Schema.Struct({ id: Schema.String });

// ─── Mutator contracts (shared by client handlers + backend) ─────────────────

export const registerUser = Mutator.make("user/register", RegisterArgs);
export const updateUser = Mutator.make("user/update", UpdateUserArgs);
export const createArticle = Mutator.make("article/create", ArticleInput);
export const updateArticle = Mutator.make("article/update", ArticleInput);
export const deleteArticle = Mutator.make("article/delete", SlugArgs);
export const favoriteArticle = Mutator.make("favorite/add", FavoriteArgs);
export const unfavoriteArticle = Mutator.make("favorite/remove", FavoriteArgs);
export const followUser = Mutator.make("follow/add", FollowArgs);
export const unfollowUser = Mutator.make("follow/remove", FollowArgs);
export const addComment = Mutator.make("comment/add", AddCommentArgs);
export const deleteComment = Mutator.make("comment/delete", CommentIdArgs);

// ─── Subsets the engine subscribes to ────────────────────────────────────────
//
// The working set is small (a demo dataset), so each tab subscribes to the
// whole of every collection and joins/filters locally. Articles are ordered
// newest-first to match Conduit's feed ordering.

export const allUsers = Subset.make({ collection: "users" });
export const allArticles = Subset.make({
  collection: "articles",
  orderBy: [{ field: "createdAt", direction: "desc" }],
});
export const allComments = Subset.make({
  collection: "comments",
  orderBy: [{ field: "createdAt", direction: "asc" }],
});
export const allFavorites = Subset.make({ collection: "favorites" });
export const allFollows = Subset.make({ collection: "follows" });

/** All subsets a client subscribes to on boot. */
export const allSubsets: ReadonlyArray<Subset.Subset> = [
  allUsers,
  allArticles,
  allComments,
  allFavorites,
  allFollows,
];

/** The id helpers, so client and backend mint identical join-row ids. */
export const favoriteId = (userId: string, articleSlug: string): string =>
  `${userId}:${articleSlug}`;
export const followId = (followerId: string, followeeId: string): string =>
  `${followerId}:${followeeId}`;

/** Slugify a title the way both the editor and the backend agree on. */
export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** The client's group identity (per-client mutation sequencing). */
export const CLIENT_ID = "svelte-realworld-tab";
export const CLIENT_GROUP_ID = "svelte-realworld";
