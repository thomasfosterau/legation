<script lang="ts">
  import { getActions } from "../actions";
  import { goto } from "$app/navigation";
  import { paths } from "../routes";
  import type { ArticleView } from "../types";

  let { article, compact = false }: { article: ArticleView; compact?: boolean } = $props();

  const actions = getActions();

  const onClick = (): void => {
    if ($actions === null) return void goto(paths.login);
    void $actions.setFavorite(article.article.slug, !article.favorited);
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
