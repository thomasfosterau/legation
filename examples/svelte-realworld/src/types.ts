/**
 * View types
 *
 * The denormalised shapes the UI renders, assembled by joining the synced
 * collections over the mirror (see `data.ts`). The engine stores normalised
 * rows; these views are computed reactively, never persisted.
 */
import type { Article, Comment, User } from "./domain";

/** A user plus whether the current viewer follows them. */
export interface ProfileView {
  readonly username: string;
  readonly bio: string;
  readonly image: string;
  readonly following: boolean;
}

/** An article plus its author profile and the viewer's favourite state. */
export interface ArticleView {
  readonly article: Article;
  readonly author: ProfileView;
  readonly favorited: boolean;
  readonly favoritesCount: number;
}

/** A comment plus its author profile. */
export interface CommentView {
  readonly comment: Comment;
  readonly author: ProfileView;
}

/** A page of articles for the home/profile feeds. */
export interface ArticlePage {
  readonly articles: ReadonlyArray<ArticleView>;
  readonly total: number;
}

/** What the home/profile feeds can be filtered by. */
export type Feed =
  | { readonly kind: "global" }
  | { readonly kind: "your" }
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "author"; readonly username: string }
  | { readonly kind: "favorited"; readonly username: string };

export type { Article, Comment, User };
