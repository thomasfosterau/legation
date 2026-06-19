<script lang="ts">
  import { hrefFor } from "../router";
  import type { ArticleView } from "../types";

  let { view }: { view: ArticleView } = $props();

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
</script>

<div class="article-meta">
  <a href={hrefFor({ name: "profile", username: view.author.username, favorites: false })}>
    <img src={view.author.image} alt={view.author.username} />
  </a>
  <div class="info">
    <a
      href={hrefFor({ name: "profile", username: view.author.username, favorites: false })}
      class="author"
    >
      {view.author.username}
    </a>
    <span class="date">{formatDate(view.article.createdAt)}</span>
  </div>
</div>
