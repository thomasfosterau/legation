<script lang="ts">
  import ArticleMeta from "./ArticleMeta.svelte";
  import FavoriteButton from "./FavoriteButton.svelte";
  import type { ArticleView } from "../types";

  let { view }: { view: ArticleView } = $props();
</script>

<div class="article-preview">
  <div class="article-meta">
    <ArticleMeta {view} />
    <div class="pull-xs-right">
      <FavoriteButton article={view} compact />
    </div>
  </div>
  <a href={`#/article/${encodeURIComponent(view.article.slug)}`} class="preview-link">
    <h1>{view.article.title}</h1>
    <p>{view.article.description}</p>
    <span>Read more...</span>
    <ul class="tag-list">
      {#each view.article.tagList as tag (tag)}
        <li class="tag-default tag-pill tag-outline">{tag}</li>
      {/each}
    </ul>
  </a>
</div>
