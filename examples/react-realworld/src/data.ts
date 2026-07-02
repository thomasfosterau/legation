/**
 * Data layer — relational reads as client-side joins
 *
 * The engine's live queries are single-collection (`useQuery(subset)`), so the
 * relational shapes Conduit renders (an article with its author + favourite
 * state, a profile with its follow state, a personal feed) are assembled here
 * by joining the synced collections **over the mirror**, reactively: each hook
 * is a `useMemo` over the live `useQuery` results, so it re-derives on every
 * mutation, push ack, and pull/rebase. Counts and flags come from the join
 * collections (`favorites`, `follows`), never denormalised onto the row — so a
 * rebase can never leave a stale counter.
 *
 * `currentUsername` (the logged-in principal, or null) is threaded in from the
 * auth context by the caller, keeping this module free of an auth import.
 */
import * as React from "react";
import { useQuery } from "@legation/react";
import {
  allArticles,
  allComments,
  allFavorites,
  allFollows,
  allUsers,
} from "./domain";
import type { Article, Comment, Favorite, Follow, User } from "./domain";
import type { ArticlePage, ArticleView, CommentView, Feed, ProfileView } from "./types";

const PAGE_SIZE = 10;

// ─── Raw collection reads ────────────────────────────────────────────────────

export const useUsers = (): ReadonlyArray<User> => {
  const rows = useQuery(allUsers);
  return React.useMemo(() => rows.map((row) => row.value as User), [rows]);
};
export const useArticlesRaw = (): ReadonlyArray<Article> => {
  const rows = useQuery(allArticles);
  return React.useMemo(() => rows.map((row) => row.value as Article), [rows]);
};
export const useCommentsRaw = (): ReadonlyArray<Comment> => {
  const rows = useQuery(allComments);
  return React.useMemo(() => rows.map((row) => row.value as Comment), [rows]);
};
export const useFavoritesRaw = (): ReadonlyArray<Favorite> => {
  const rows = useQuery(allFavorites);
  return React.useMemo(() => rows.map((row) => row.value as Favorite), [rows]);
};
export const useFollowsRaw = (): ReadonlyArray<Follow> => {
  const rows = useQuery(allFollows);
  return React.useMemo(() => rows.map((row) => row.value as Follow), [rows]);
};

// ─── Join helpers (pure) ─────────────────────────────────────────────────────

const emptyProfile = (username: string): ProfileView => ({
  username,
  bio: "",
  image: "https://static.productionready.io/images/smiley-cyrus.jpg",
  following: false,
});

const toProfile = (
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

const toArticleView = (
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

// ─── Derived reads ───────────────────────────────────────────────────────────

/** The distinct tags across all articles, most-used first. */
export const useTags = (): ReadonlyArray<string> => {
  const articles = useArticlesRaw();
  return React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const article of articles)
      for (const tag of article.tagList) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }, [articles]);
};

/** A paginated, filtered list of article views. */
export const useArticles = (
  feed: Feed,
  page: number,
  currentUsername: string | null
): ArticlePage => {
  const articles = useArticlesRaw();
  const users = useUsers();
  const follows = useFollowsRaw();
  const favorites = useFavoritesRaw();

  return React.useMemo(() => {
    let filtered = articles;
    switch (feed.kind) {
      case "global":
        break;
      case "your": {
        const followees = new Set(
          follows.filter((f) => f.followerId === currentUsername).map((f) => f.followeeId)
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
      articles: pageRows.map((a) => toArticleView(a, users, follows, favorites, currentUsername)),
    };
  }, [articles, users, follows, favorites, feed, page, currentUsername]);
};

/** A single article view by slug (undefined while loading / not found). */
export const useArticle = (
  slug: string,
  currentUsername: string | null
): ArticleView | undefined => {
  const articles = useArticlesRaw();
  const users = useUsers();
  const follows = useFollowsRaw();
  const favorites = useFavoritesRaw();
  return React.useMemo(() => {
    const article = articles.find((a) => a.slug === slug);
    return article === undefined
      ? undefined
      : toArticleView(article, users, follows, favorites, currentUsername);
  }, [articles, users, follows, favorites, slug, currentUsername]);
};

/** Comments on an article, oldest first, with author profiles. */
export const useComments = (
  slug: string,
  currentUsername: string | null
): ReadonlyArray<CommentView> => {
  const comments = useCommentsRaw();
  const users = useUsers();
  const follows = useFollowsRaw();
  return React.useMemo(
    () =>
      comments
        .filter((c) => c.articleSlug === slug)
        .map((comment) => ({
          comment,
          author: toProfile(comment.authorId, users, follows, currentUsername),
        })),
    [comments, users, follows, slug, currentUsername]
  );
};

/** A profile view by username. */
export const useProfile = (
  username: string,
  currentUsername: string | null
): ProfileView => {
  const users = useUsers();
  const follows = useFollowsRaw();
  return React.useMemo(
    () => toProfile(username, users, follows, currentUsername),
    [users, follows, username, currentUsername]
  );
};

export { PAGE_SIZE };
