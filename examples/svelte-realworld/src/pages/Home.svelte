<script lang="ts">
  /**
   * Home — banner, feed tabs (Your Feed / Global / #tag), popular tags sidebar.
   */
  import { getAuth } from "../auth";
  import { getData } from "../data";
  import { toArticlePage, toTags } from "../joins";
  import ArticleList from "../components/ArticleList.svelte";
  import type { Feed } from "../types";

  const { currentUsername } = getAuth();
  const data = getData();
  const { users, articles, follows, favorites } = data;

  let tab = $state<"your" | "global" | "tag">($currentUsername ? "your" : "global");
  let tag = $state<string | null>(null);
  let page = $state(0);

  const feed = $derived<Feed>(
    tab === "tag" && tag !== null
      ? { kind: "tag", tag }
      : tab === "your"
        ? { kind: "your" }
        : { kind: "global" }
  );

  const tags = $derived(toTags($articles));
  const articlePage = $derived(
    toArticlePage(feed, page, $currentUsername, $articles, $users, $follows, $favorites)
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
            {#if $currentUsername}
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
