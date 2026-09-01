/**
 * Actions — the write surface
 *
 * Thin wrappers over `useMutation()` that mint ids/timestamps and attribute the
 * write to the signed-in user. Each is an optimistic mutation: the overlay
 * updates before any round trip, the same intent is replayed on rebase, and it
 * is applied authoritatively (with ownership checks) on the backend.
 *
 * `getActions()` returns null when anonymous, otherwise an action set bound to
 * the current user. It reads the session and the Client runtime from context,
 * so — like any hook — it must be called during component initialisation; the
 * result is a `$derived`, so it tracks login/logout.
 */
import { useMutation } from "@legation/svelte/Runes";
import { getSession } from "./session.svelte";
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

/** All write actions, bound to the current user. Null when anonymous. */
export const getActions = (): { readonly current: Actions | null } => {
  const mutate = useMutation();
  const session = getSession();

  const bind = (me: string): Actions => ({
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
      mutate(favorited ? "favorite/add" : "favorite/remove", { userId: me, articleSlug: slug }),
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
  });

  const actions = $derived(session.username === null ? null : bind(session.username));
  return {
    get current() {
      return actions;
    },
  };
};

/** Stable references so callers can mint ids/keys identically to the engine. */
export { favoriteId, followId };
