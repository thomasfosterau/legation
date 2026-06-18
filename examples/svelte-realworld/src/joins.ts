/**
 * Join helpers (pure)
 *
 * The relational shapes Conduit renders (an article with its author + favourite
 * state, a profile with its follow state, a personal feed) are assembled by
 * joining the synced collections. These functions are pure — they take the raw
 * collection arrays plus the viewer and return the denormalised views; no
 * framework imports. Components combine the base stores with `$derived` and call
 * these to compute views reactively. Counts and flags come from the join
 * collections (`favorites`, `follows`), never denormalised onto the row — so a
 * rebase can never leave a stale counter.
 */
import type { Article, Comment, Favorite, Follow, User } from "./domain";
import type { ArticlePage, ArticleView, CommentView, Feed, ProfileView } from "./types";

export const PAGE_SIZE = 10;

const emptyProfile = (username: string): ProfileView => ({
  username,
  bio: "",
  image: "https://static.productionready.io/images/smiley-cyrus.jpg",
  following: false,
});

export const toProfile = (
  username: string,
  users: ReadonlyArray<User>,
  follows: ReadonlyArray<Follow>,
  viewer: string | null
): ProfileView => {
  const user = users.find((candidate) => candidate.username === username);
  const base = user
    ? { username: user.username, bio: user.bio, image: user.image || emptyProfile(username).image }
    : emptyProfile(username);
  return {
    ...base,
    following:
      viewer !== null &&
      follows.some((f) => f.followerId === viewer && f.followeeId === username),
  };
};

export const toArticleView = (
  article: Article,
  users: ReadonlyArray<User>,
  follows: ReadonlyArray<Follow>,
  favorites: ReadonlyArray<Favorite>,
  viewer: string | null
): ArticleView => ({
  article,
  author: toProfile(article.authorId, users, follows, viewer),
  favorited:
    viewer !== null &&
    favorites.some((f) => f.userId === viewer && f.articleSlug === article.slug),
  favoritesCount: favorites.filter((f) => f.articleSlug === article.slug).length,
});

/** The distinct tags across all articles, most-used first. */
export const toTags = (articles: ReadonlyArray<Article>): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const article of articles)
    for (const tag of article.tagList) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
};

/** A paginated, filtered list of article views. */
export const toArticlePage = (
  feed: Feed,
  page: number,
  viewer: string | null,
  articles: ReadonlyArray<Article>,
  users: ReadonlyArray<User>,
  follows: ReadonlyArray<Follow>,
  favorites: ReadonlyArray<Favorite>
): ArticlePage => {
  let filtered = articles;
  switch (feed.kind) {
    case "global":
      break;
    case "your": {
      const followees = new Set(
        follows.filter((f) => f.followerId === viewer).map((f) => f.followeeId)
      );
      filtered = articles.filter((a) => followees.has(a.authorId));
      break;
    }
    case "tag":
      filtered = articles.filter((a) => a.tagList.includes(feed.tag));
      break;
    case "author":
      filtered = articles.filter((a) => a.authorId === feed.username);
      break;
    case "favorited": {
      const slugs = new Set(
        favorites.filter((f) => f.userId === feed.username).map((f) => f.articleSlug)
      );
      filtered = articles.filter((a) => slugs.has(a.slug));
      break;
    }
  }
  const total = filtered.length;
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  return {
    total,
    articles: pageRows.map((a) => toArticleView(a, users, follows, favorites, viewer)),
  };
};

/** A single article view by slug (undefined while loading / not found). */
export const toArticle = (
  slug: string,
  viewer: string | null,
  articles: ReadonlyArray<Article>,
  users: ReadonlyArray<User>,
  follows: ReadonlyArray<Follow>,
  favorites: ReadonlyArray<Favorite>
): ArticleView | undefined => {
  const article = articles.find((a) => a.slug === slug);
  return article === undefined
    ? undefined
    : toArticleView(article, users, follows, favorites, viewer);
};

/** Comments on an article, oldest first, with author profiles. */
export const toComments = (
  slug: string,
  viewer: string | null,
  comments: ReadonlyArray<Comment>,
  users: ReadonlyArray<User>,
  follows: ReadonlyArray<Follow>
): ReadonlyArray<CommentView> =>
  comments
    .filter((c) => c.articleSlug === slug)
    .map((comment) => ({
      comment,
      author: toProfile(comment.authorId, users, follows, viewer),
    }));
