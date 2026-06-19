<script lang="ts">
  import ArticlePreview from "./ArticlePreview.svelte";
  import { PAGE_SIZE } from "../joins";
  import type { ArticlePage } from "../types";

  let {
    page,
    pageIndex,
    onPage,
    emptyText = "No articles are here... yet.",
  }: {
    page: ArticlePage;
    pageIndex: number;
    onPage: (page: number) => void;
    emptyText?: string;
  } = $props();

  const pageCount = $derived(Math.ceil(page.total / PAGE_SIZE));
</script>

{#if page.articles.length === 0}
  <div class="article-preview">{emptyText}</div>
{:else}
  {#each page.articles as view (view.article.slug)}
    <ArticlePreview {view} />
  {/each}
  {#if pageCount > 1}
    <nav>
      <ul class="pagination">
        {#each Array.from({ length: pageCount }, (_, i) => i) as i (i)}
          <li class={`page-item ${i === pageIndex ? "active" : ""}`}>
            <button class="page-link" onclick={() => onPage(i)}>{i + 1}</button>
          </li>
        {/each}
      </ul>
    </nav>
  {/if}
{/if}
