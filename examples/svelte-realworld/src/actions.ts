/**
 * Actions — the write surface
 *
 * Thin wrappers over `getMutate()` that mint ids/timestamps and attribute the
 * write to the logged-in user. Each is an optimistic mutator: the overlay
 * updates before any round trip, and the same intent is replayed on rebase and
 * applied authoritatively (with ownership checks) on the backend.
 *
 * `getActions()` returns a live `Readable<Actions | null>` derived from the
 * session: null when anonymous, otherwise bound to the current user. Read it
 * with `$actions` so it tracks login/logout reactively.
 */
import { derived, type Readable } from "svelte/store";
import { Mutation } from "@legation/svelte";
import { getAuth } from "./auth";
import { favoriteId, followId, slugify } from "./domain";
import type { Article } from "./domain";

export interface Actions {
  readonly createArticle: (input: {
    title: string;
    description: string;
    body: string;
    tagList: ReadonlyArray<string>;
  }) => Promise<string>;
  readonly updateArticle: (slug: string, patch: Partial<Article>) => Promise<void>;
  readonly deleteArticle: (slug: string) => Promise<void>;
  readonly setFavorite: (slug: string, favorited: boolean) => Promise<void>;
  readonly setFollow: (username: string, following: boolean) => Promise<void>;
  readonly addComment: (slug: string, body: string) => Promise<void>;
  readonly deleteComment: (id: string) => Promise<void>;
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

/** All write actions, bound to the current user. Emits null when anonymous. */
export const getActions = (): Readable<Actions | null> => {
  const mutate = Mutation.getMutate();
  const { currentUsername } = getAuth();

  return derived(currentUsername, (username) => {
    if (username === null) return null;
    const me = username;
    return {
      createArticle: async ({ title, description, body, tagList }) => {
        const base = slugify(title) || newId().slice(0, 8);
        const slug = `${base}-${newId().slice(0, 6)}`;
        const now = Date.now();
        await mutate("article/create", {
          slug,
          title,
          description,
          body,
          tagList,
          authorId: me,
          createdAt: now,
          updatedAt: now,
        });
        return slug;
      },
      updateArticle: (slug, patch) =>
        mutate("article/update", {
          slug,
          title: patch.title ?? "",
          description: patch.description ?? "",
          body: patch.body ?? "",
          tagList: patch.tagList ?? [],
          authorId: me,
          createdAt: patch.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        }),
      deleteArticle: (slug) => mutate("article/delete", { slug }),
      setFavorite: (slug, favorited) =>
        mutate(favorited ? "favorite/add" : "favorite/remove", {
          userId: me,
          articleSlug: slug,
        }),
      setFollow: (username, following) =>
        mutate(following ? "follow/add" : "follow/remove", {
          followerId: me,
          followeeId: username,
        }),
      addComment: (slug, body) =>
        mutate("comment/add", {
          id: newId(),
          articleSlug: slug,
          authorId: me,
          body,
          createdAt: Date.now(),
        }),
      deleteComment: (id) => mutate("comment/delete", { id }),
    } satisfies Actions;
  });
};

/** Stable references so callers can mint ids/keys identically to the engine. */
export { favoriteId, followId };
