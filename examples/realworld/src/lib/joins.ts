/**
 * View shaping (pure)
 *
 * Conduit's relational shapes — an article with its author and favourite
 * state, a profile with its follow state, a personal feed — come from the
 * **reads**: `allArticles` `include`s `author` and `favorites`, `userProfile`
 * `include`s `followers`, `articleComments` `include`s each comment's `author`.
 * So these functions no longer join; they read the edge the read already asked
 * for and shape it for the UI. They stay pure, with no framework imports.
 *
 * Counts and flags come from the join collections, never denormalised onto the
 * row — so a rebase can never leave a stale counter.
 */
import type { Client } from "@thomasfosterau/legation-effect";
import type { Article, Comment, Favorite, Follow, User } from "./domain";
import type { ArticlePage, ArticleView, CommentView, Feed, ProfileView } from "./types";

/** Rows as a read resolves them: the node value plus its `include`d edges. */
export type Rows = ReadonlyArray<Client.ResolvedRow>;

export const PAGE_SIZE = 10;

const DEFAULT_IMAGE = "https://static.productionready.io/images/smiley-cyrus.jpg";

// A resolved edge is `unknown` — the node graph types the schema, but not what
// a read hands back — so each accessor casts once, here.
const one = <T>(row: Client.ResolvedRow, edge: string): T | null =>
  (row.related[edge] as T | null | undefined) ?? null;
const many = <T>(row: Client.ResolvedRow, edge: string): ReadonlyArray<T> =>
  (row.related[edge] as ReadonlyArray<T> | undefined) ?? [];

/** A profile from a user row (or a placeholder), plus the viewer's follow state. */
export const profileOf = (
  user: User | null,
  username: string,
  following: boolean
): ProfileView => ({
  username: user?.username ?? username,
  bio: user?.bio ?? "",
  image: user?.image || DEFAULT_IMAGE,
  following,
});

/** Does `viewer` follow `username`, per the given follow rows? */
export const isFollowing = (
  follows: ReadonlyArray<Follow>,
  viewer: string | null,
  username: string
): boolean =>
  viewer !== null && follows.some((f) => f.followerId === viewer && f.followeeId === username);

/**
 * One article card from a resolved row: the `author` edge is the profile, the
 * `favorites` edge is both the count and the viewer's own favourite flag.
 */
export const toArticleView = (
  row: Client.ResolvedRow,
  follows: ReadonlyArray<Follow>,
  viewer: string | null
): ArticleView => {
  const article = row.value as Article;
  const favorites = many<Favorite>(row, "favorites");
  return {
    article,
    author: profileOf(
      one<User>(row, "author"),
      article.authorId,
      isFollowing(follows, viewer, article.authorId)
    ),
    favorited: viewer !== null && favorites.some((f) => f.userId === viewer),
    favoritesCount: favorites.length,
  };
};

/** The distinct tags across the read's articles, most-used first. */
export const toTags = (rows: Rows): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const row of rows)
    for (const tag of (row.value as Article).tagList) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
};

/**
 * A paginated, filtered page of article cards. The feed filters are set
 * operations over the join collections — which articles a user follows the
 * author of, or has favourited — so those two reads are passed in whole.
 */
export const toArticlePage = (
  feed: Feed,
  page: number,
  viewer: string | null,
  rows: Rows,
  follows: ReadonlyArray<Follow>,
  favorites: ReadonlyArray<Favorite>
): ArticlePage => {
  const article = (row: Client.ResolvedRow): Article => row.value as Article;
  let filtered = rows;
  switch (feed.kind) {
    case "global":
      break;
    case "your": {
      const followees = new Set(
        follows.filter((f) => f.followerId === viewer).map((f) => f.followeeId)
      );
      filtered = rows.filter((row) => followees.has(article(row).authorId));
      break;
    }
    case "tag":
      filtered = rows.filter((row) => article(row).tagList.includes(feed.tag));
      break;
    case "author":
      filtered = rows.filter((row) => article(row).authorId === feed.username);
      break;
    case "favorited": {
      const slugs = new Set(
        favorites.filter((f) => f.userId === feed.username).map((f) => f.articleSlug)
      );
      filtered = rows.filter((row) => slugs.has(article(row).slug));
      break;
    }
  }
  return {
    total: filtered.length,
    articles: filtered
      .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
      .map((row) => toArticleView(row, follows, viewer)),
  };
};

/** The single article a by-slug read resolves to (undefined while loading). */
export const toArticle = (
  rows: Rows,
  follows: ReadonlyArray<Follow>,
  viewer: string | null
): ArticleView | undefined =>
  rows.length === 0 ? undefined : toArticleView(rows[0]!, follows, viewer);

/**
 * A profile from a `userProfile` read: the `followers` edge carries exactly the
 * follow rows pointing at this user, so the viewer's follow state is a lookup
 * in what the read already resolved — no global follows needed.
 */
export const toProfile = (rows: Rows, username: string, viewer: string | null): ProfileView => {
  const row = rows[0];
  if (row === undefined) return profileOf(null, username, false);
  const followers = many<Follow>(row, "followers");
  return profileOf(
    row.value as User,
    username,
    viewer !== null && followers.some((f) => f.followerId === viewer)
  );
};

/**
 * Comments with their author profiles, from a read that `include`s `author`.
 * (Comment authors don't surface a follow flag in the UI.)
 */
export const toComments = (rows: Rows): ReadonlyArray<CommentView> =>
  rows.map((row) => {
    const comment = row.value as Comment;
    return { comment, author: profileOf(one<User>(row, "author"), comment.authorId, false) };
  });

/** Plain rows of one collection, for the reads with no edges. */
export const values = <T>(rows: Rows): ReadonlyArray<T> => rows.map((row) => row.value as T);
