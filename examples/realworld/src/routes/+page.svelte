<script lang="ts">
  /**
   * Home — banner, feed tabs (Your Feed / Global / #tag), popular tags sidebar.
   *
   * One read carries the cards: `allArticles` `include`s each article's author
   * and favourites, so the list needs no join of its own. The feed filters are
   * set operations over the follow/favourite collections, which is why those
   * two reads are here too.
   */
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@legation/svelte";
  import { allArticles, allFavorites, allFollows, type Favorite, type Follow } from "$lib/domain";
  import { toArticlePage, toTags, values } from "$lib/joins";
  import { getSession } from "$lib/session.svelte";
  import ArticleList from "$lib/components/ArticleList.svelte";
  import type { Feed } from "$lib/types";

  const session = getSession();
  const articleRows = useQuery(() => allArticles);
  const followRows = useQuery(() => allFollows);
  const favoriteRows = useQuery(() => allFavorites);

  let tab = $state<"your" | "global" | "tag">(session.username ? "your" : "global");
  let tag = $state<string | null>(null);
  let page = $state(0);

  const articles = $derived(AsyncResult.getOrElse(articleRows.current, () => []));
  const follows = $derived(values<Follow>(AsyncResult.getOrElse(followRows.current, () => [])));
  const favorites = $derived(
    values<Favorite>(AsyncResult.getOrElse(favoriteRows.current, () => []))
  );

  const feed = $derived<Feed>(
    tab === "tag" && tag !== null
      ? { kind: "tag", tag }
      : tab === "your"
        ? { kind: "your" }
        : { kind: "global" }
  );

  const tags = $derived(toTags(articles));
  const articlePage = $derived(
    toArticlePage(feed, page, session.username, articles, follows, favorites)
  );

  const select = (next: "your" | "global" | "tag", nextTag?: string): void => {
    tab = next;
    tag = nextTag ?? null;
    page = 0;
  };
</script>

<div class="home-page">
  <div class="banner">
    <div class="container">
      <h1 class="logo-font">conduit</h1>
      <p>A place to share your knowledge. Synced with legation.</p>
    </div>
  </div>

  <div class="container page">
    <div class="row">
      <div class="col-md-9">
        <div class="feed-toggle">
          <ul class="nav nav-pills outline-active">
            {#if session.username}
              <li class="nav-item">
                <button
                  class={`nav-link ${tab === "your" ? "active" : ""}`}
                  onclick={() => select("your")}
                >
                  Your Feed
                </button>
              </li>
            {/if}
            <li class="nav-item">
              <button
                class={`nav-link ${tab === "global" ? "active" : ""}`}
                onclick={() => select("global")}
              >
                Global Feed
              </button>
            </li>
            {#if tab === "tag" && tag}
              <li class="nav-item">
                <button class="nav-link active">
                  <i class="ion-pound"></i>
                  {tag}
                </button>
              </li>
            {/if}
          </ul>
        </div>

        <ArticleList page={articlePage} pageIndex={page} onPage={(p) => (page = p)} />
      </div>

      <div class="col-md-3">
        <div class="sidebar">
          <p>Popular Tags</p>
          <div class="tag-list">
            {#if tags.length === 0}
              <span class="tag-default tag-pill">no tags yet</span>
            {/if}
            {#each tags as t (t)}
              <button class="tag-pill tag-default" onclick={() => select("tag", t)}>{t}</button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
