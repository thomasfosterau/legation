<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { getActions } from "../actions.svelte";
  import type { ArticleView } from "../types";

  let { article, compact = false }: { article: ArticleView; compact?: boolean } = $props();

  const actions = getActions();

  const onClick = (): void => {
    const current = actions.current;
    if (current === null) return void goto(resolve("/login"));
    void current.setFavorite(article.article.slug, !article.favorited);
  };
</script>

<button
  class={`btn btn-sm ${article.favorited ? "btn-primary" : "btn-outline-primary"}`}
  onclick={onClick}
>
  <i class="ion-heart"></i>
  {#if compact}
    <span>{article.favoritesCount}</span>
  {:else}
    {article.favorited ? "Unfavorite" : "Favorite"}
    <span class="counter">({article.favoritesCount})</span>
  {/if}
</button>
