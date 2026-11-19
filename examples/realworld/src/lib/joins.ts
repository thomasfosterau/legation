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
 *
 * The reads are declared `as const satisfies Query.Read`, so their rows arrive
 * typed from the node graph: `row.value` is the node's row and `row.related`
 * carries exactly the edges the read includes. Nothing here casts.
 */
import type { Client, Query } from "@thomasfosterau/legation";
import type { Favorite, Follow, User, allArticles, articleComments, userProfile } from "./domain";
import type { ArticlePage, ArticleView, CommentView, Feed, ProfileView } from "./types";

/** The rows a read resolves to, typed from the read and the registered graph. */
export type Rows<R extends Query.Read> = ReadonlyArray<Client.ResolvedRow<R>>;

/** An article row with the `author` and `favorites` edges every card reads. */
export type ArticleRow = Client.ResolvedRow<typeof allArticles>;

export const PAGE_SIZE = 10;

const DEFAULT_IMAGE = "https://static.productionready.io/images/smiley-cyrus.jpg";

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
  row: ArticleRow,
  follows: ReadonlyArray<Follow>,
  viewer: string | null
): ArticleView => {
  const { value: article, related } = row;
  const favorites = related.favorites;
  return {
    article,
    author: profileOf(
      related.author,
      article.authorId,
      isFollowing(follows, viewer, article.authorId)
    ),
    favorited: viewer !== null && favorites.some((f) => f.userId === viewer),
    favoritesCount: favorites.length,
  };
};

/** The distinct tags across the read's articles, most-used first. */
export const toTags = (rows: ReadonlyArray<ArticleRow>): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const row of rows)
    for (const tag of row.value.tagList) counts.set(tag, (counts.get(tag) ?? 0) + 1);
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
  rows: ReadonlyArray<ArticleRow>,
  follows: ReadonlyArray<Follow>,
  favorites: ReadonlyArray<Favorite>
): ArticlePage => {
  const article = (row: ArticleRow) => row.value;
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
  rows: ReadonlyArray<ArticleRow>,
  follows: ReadonlyArray<Follow>,
  viewer: string | null
): ArticleView | undefined =>
  rows.length === 0 ? undefined : toArticleView(rows[0]!, follows, viewer);

/**
 * A profile from a `userProfile` read: the `followers` edge carries exactly the
 * follow rows pointing at this user, so the viewer's follow state is a lookup
 * in what the read already resolved — no global follows needed.
 */
export const toProfile = (
  rows: Rows<ReturnType<typeof userProfile>>,
  username: string,
  viewer: string | null
): ProfileView => {
  const row = rows[0];
  if (row === undefined) return profileOf(null, username, false);
  const followers = row.related.followers;
  return profileOf(
    row.value,
    username,
    viewer !== null && followers.some((f) => f.followerId === viewer)
  );
};

/**
 * Comments with their author profiles, from a read that `include`s `author`.
 * (Comment authors don't surface a follow flag in the UI.)
 */
export const toComments = (
  rows: Rows<ReturnType<typeof articleComments>>
): ReadonlyArray<CommentView> =>
  rows.map(({ value: comment, related: { author } }) => ({
    comment,
    author: profileOf(author, comment.authorId, false),
  }));

/** Plain row values of one collection, for the reads with no edges. */
export const values = <R extends Query.Read>(
  rows: Rows<R>
): ReadonlyArray<Client.ResolvedRow<R>["value"]> => rows.map((row) => row.value);
