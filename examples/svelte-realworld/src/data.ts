/**
 * Data layer — base collection stores
 *
 * The engine's live queries are single-collection (`query(subset)`). Here we map
 * each subset's rows to a typed `Readable` of domain rows. The set of base
 * stores is built once in the root (after `setEngineRuntime`) and shared via
 * context, so descendant components read the same live stores and combine them
 * with `$derived` + the pure helpers in `joins.ts` to compute views reactively.
 */
import { derived, type Readable } from "svelte/store";
import { getContext, setContext } from "svelte";
import { query } from "@thomasfosterau/effect-sync-svelte";
import { allArticles, allComments, allFavorites, allFollows, allUsers } from "./domain";
import type { Article, Comment, Favorite, Follow, User } from "./domain";

export interface Data {
  readonly users: Readable<ReadonlyArray<User>>;
  readonly articles: Readable<ReadonlyArray<Article>>;
  readonly comments: Readable<ReadonlyArray<Comment>>;
  readonly favorites: Readable<ReadonlyArray<Favorite>>;
  readonly follows: Readable<ReadonlyArray<Follow>>;
}

/** Build the base collection stores. Call during init, after setEngineRuntime. */
export const createData = (): Data => ({
  users: derived(query(allUsers), (rows) => rows.map((r) => r.value as User)),
  articles: derived(query(allArticles), (rows) => rows.map((r) => r.value as Article)),
  comments: derived(query(allComments), (rows) => rows.map((r) => r.value as Comment)),
  favorites: derived(query(allFavorites), (rows) => rows.map((r) => r.value as Favorite)),
  follows: derived(query(allFollows), (rows) => rows.map((r) => r.value as Follow)),
});

const DATA_KEY = Symbol("svelte-realworld/data");

export const setData = (data: Data): void => {
  setContext(DATA_KEY, data);
};

export const getData = (): Data => {
  const data = getContext<Data | undefined>(DATA_KEY);
  if (data === undefined) throw new Error("setData(data) must be called higher in the tree");
  return data;
};
