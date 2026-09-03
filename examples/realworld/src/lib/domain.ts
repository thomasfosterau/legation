/**
 * Domain — RealWorld (Conduit)
 *
 * The shared sync vocabulary for a Medium-style blogging app, defined once and
 * used on both sides of the engine (CONTEXT.md), in ADR-0022's concepts:
 *
 *   users      — accounts/profiles   (articles, favorites, followers, following)
 *   articles   — posts               (author, comments, favorites)
 *   comments   — article comments    (article, author)
 *   favorites  — a user⇄article join (user, article)
 *   follows    — a follower⇄followee join (follower, followee)
 *
 * The graph is declared as **Nodes and Edges**: each foreign key is declared
 * exactly once, on the child (`Edge.one(..., { via })`), and the parent names
 * the inverse. A screen's join is then part of its **read** — `include: {
 * author: true, favorites: true }` resolves onto each row's `related`.
 *
 * A node's identity field is always `id`, so Conduit's natural keys ride along
 * as ordinary attributes: `users.id === users.username` and
 * `articles.id === articles.slug`, minted together wherever a row is written.
 *
 * Reads are public (allow-all auth); writes are *named, schema-validated
 * mutations* run optimistically on the client and authoritatively on the demo
 * backend, which enforces ownership against the request identity (see
 * `sync.ts`). Counts (favoritesCount) and flags (favorited, following) are
 * derived from the join collections, never denormalised onto the row — so a
 * rebase can never leave a stale counter.
 */

import { Schema } from "effect";
import { Edge, Mutation, Node, type Query } from "@legation/effect";

// ─── Row schemas ─────────────────────────────────────────────────────────────

export const User = Schema.Struct({
  /** Row id. Conduit identifies users by username, so `id === username`. */
  id: Schema.String,
  username: Schema.String,
  email: Schema.String,
  /** Demo-only plaintext password (never do this for real). */
  password: Schema.String,
  bio: Schema.String,
  image: Schema.String,
});
export type User = typeof User.Type;

export const Article = Schema.Struct({
  /** Row id. Conduit identifies articles by slug, so `id === slug`. */
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  body: Schema.String,
  tagList: Schema.Array(Schema.String),
  /** References `users.id`. */
  authorId: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type Article = typeof Article.Type;

export const Comment = Schema.Struct({
  id: Schema.String,
  /** References `articles.id`. */
  articleSlug: Schema.String,
  /** References `users.id`. */
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

// ─── The node graph ──────────────────────────────────────────────────────────
//
// `Node.make` supplies `id` and every `Edge.one`'s `via` foreign key, so the
// attributes are the schema minus those fields.

const { id: _userId, ...userAttributes } = User.fields;
const { id: _articleId, authorId: _articleAuthorId, ...articleAttributes } = Article.fields;
const {
  id: _commentId,
  articleSlug: _commentArticleSlug,
  authorId: _commentAuthorId,
  ...commentAttributes
} = Comment.fields;

export const users = Node.make("users", {
  attributes: userAttributes,
  edges: {
    articles: Edge.many("articles", { inverse: "author" }),
    favorites: Edge.many("favorites", { inverse: "user" }),
    followers: Edge.many("follows", { inverse: "followee" }),
    following: Edge.many("follows", { inverse: "follower" }),
  },
});

export const articles = Node.make("articles", {
  attributes: articleAttributes,
  edges: {
    author: Edge.one("users", { via: "authorId" }),
    comments: Edge.many("comments", { inverse: "article" }),
    favorites: Edge.many("favorites", { inverse: "article" }),
  },
  sortable: ["createdAt"],
});

export const comments = Node.make("comments", {
  attributes: commentAttributes,
  edges: {
    article: Edge.one("articles", { via: "articleSlug" }),
    author: Edge.one("users", { via: "authorId" }),
  },
  sortable: ["createdAt"],
});

export const favorites = Node.make("favorites", {
  attributes: {},
  edges: {
    user: Edge.one("users", { via: "userId" }),
    article: Edge.one("articles", { via: "articleSlug" }),
  },
});

export const follows = Node.make("follows", {
  attributes: {},
  edges: {
    follower: Edge.one("users", { via: "followerId" }),
    followee: Edge.one("users", { via: "followeeId" }),
  },
});

/** The closed, validated graph: nodes + the derived engine registry. */
export const nodes = Node.registry([users, articles, comments, favorites, follows]);

// ─── Reads ───────────────────────────────────────────────────────────────────
//
// The working set is small (a demo dataset), so the tab syncs every collection
// and the feeds filter/paginate locally. Articles are newest-first to match
// Conduit's feed ordering.

/** Articles with the author and favourites every card needs, newest first. */
export const allArticles: Query.Read = {
  collection: "articles",
  order: ["-createdAt"],
  include: { author: true, favorites: true },
};

/** One article by slug, with the same edges as the feed cards. */
export const articleBySlug = (slug: string): Query.Read => ({
  collection: "articles",
  where: { id: slug },
  include: { author: true, favorites: true },
});

/** One article's comments, oldest first, each with its author resolved. */
export const articleComments = (slug: string): Query.Read => ({
  collection: "comments",
  where: { articleSlug: slug },
  order: ["createdAt"],
  include: { author: true },
});

/** One profile, with the follow rows that decide the viewer's follow state. */
export const userProfile = (username: string): Query.Read => ({
  collection: "users",
  where: { id: username },
  include: { followers: true },
});

export const allUsers: Query.Read = { collection: "users" };
export const allFollows: Query.Read = { collection: "follows" };
export const allFavorites: Query.Read = { collection: "favorites" };

/**
 * What the shell pins for the tab's lifetime. The feed filters ("your feed",
 * "favorited by") are set operations over whole join collections, and an
 * `include` only resolves against rows this client has synced — so the whole
 * working set stays subscribed.
 */
export const shellReads: ReadonlyArray<Query.Read> = [
  { collection: "users" },
  { collection: "articles" },
  { collection: "comments" },
  { collection: "favorites" },
  { collection: "follows" },
];

// ─── Mutation args ───────────────────────────────────────────────────────────
//
// Args keep Conduit's natural keys; the handlers mint the row `id` from them.

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
export type UpdateUserArgs = typeof UpdateUserArgs.Type;
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
export type ArticleInput = typeof ArticleInput.Type;
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

// ─── Mutation contracts (shared by client handlers + backend) ────────────────

export const registerUser = Mutation.make("user/register", RegisterArgs);
export const updateUser = Mutation.make("user/update", UpdateUserArgs);
export const createArticle = Mutation.make("article/create", ArticleInput);
export const updateArticle = Mutation.make("article/update", ArticleInput);
export const deleteArticle = Mutation.make("article/delete", SlugArgs);
export const favoriteArticle = Mutation.make("favorite/add", FavoriteArgs);
export const unfavoriteArticle = Mutation.make("favorite/remove", FavoriteArgs);
export const followUser = Mutation.make("follow/add", FollowArgs);
export const unfollowUser = Mutation.make("follow/remove", FollowArgs);
export const addComment = Mutation.make("comment/add", AddCommentArgs);
export const deleteComment = Mutation.make("comment/delete", CommentIdArgs);

/** The id helpers, so client and backend mint identical join-row ids. */
export const favoriteId = (userId: string, articleSlug: string): string =>
  `${userId}:${articleSlug}`;
export const followId = (followerId: string, followeeId: string): string =>
  `${followerId}:${followeeId}`;

/** The row a register/update writes: `id` is the username. */
export const userRow = (args: UpdateUserArgs | typeof RegisterArgs.Type): User => ({
  id: args.username,
  username: args.username,
  email: args.email,
  password: args.password,
  bio: "bio" in args ? args.bio : "",
  image: "image" in args ? args.image : "",
});

/** The row an article create/update writes: `id` is the slug. */
export const articleRow = (args: ArticleInput): Article => ({ id: args.slug, ...args });

export const favoriteRow = (userId: string, articleSlug: string): Favorite => ({
  id: favoriteId(userId, articleSlug),
  userId,
  articleSlug,
});

export const followRow = (followerId: string, followeeId: string): Follow => ({
  id: followId(followerId, followeeId),
  followerId,
  followeeId,
});

/**
 * The client's optimistic handlers. They re-run on every rebase, so each is a
 * `put`/`del` keyed by id — idempotent by construction.
 */
export const mutations = Mutation.registry([
  { mutator: registerUser, local: (args, w) => w.put("users", args.username, userRow(args)) },
  { mutator: updateUser, local: (args, w) => w.put("users", args.username, userRow(args)) },
  { mutator: createArticle, local: (args, w) => w.put("articles", args.slug, articleRow(args)) },
  { mutator: updateArticle, local: (args, w) => w.put("articles", args.slug, articleRow(args)) },
  { mutator: deleteArticle, local: (args, w) => w.del("articles", args.slug) },
  {
    mutator: favoriteArticle,
    local: (args, w) =>
      w.put(
        "favorites",
        favoriteId(args.userId, args.articleSlug),
        favoriteRow(args.userId, args.articleSlug)
      ),
  },
  {
    mutator: unfavoriteArticle,
    local: (args, w) => w.del("favorites", favoriteId(args.userId, args.articleSlug)),
  },
  {
    mutator: followUser,
    local: (args, w) =>
      w.put(
        "follows",
        followId(args.followerId, args.followeeId),
        followRow(args.followerId, args.followeeId)
      ),
  },
  {
    mutator: unfollowUser,
    local: (args, w) => w.del("follows", followId(args.followerId, args.followeeId)),
  },
  { mutator: addComment, local: (args, w) => w.put("comments", args.id, args) },
  { mutator: deleteComment, local: (args, w) => w.del("comments", args.id) },
]);

/** Slugify a title the way both the editor and the backend agree on. */
export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** The client's group identity (per-client mutation sequencing). */
export const CLIENT_ID = "realworld-tab";
export const CLIENT_GROUP_ID = "realworld";
