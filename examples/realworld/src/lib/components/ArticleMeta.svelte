<script lang="ts">
  import { resolve } from "$app/paths";
  import type { ArticleView } from "../types";

  let { view }: { view: ArticleView } = $props();

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
</script>

<div class="article-meta">
  <a href={resolve("/profile/[username]/[[tab=favorites]]", { username: view.author.username })}>
    <img src={view.author.image} alt={view.author.username} />
  </a>
  <div class="info">
    <a
      href={resolve("/profile/[username]/[[tab=favorites]]", { username: view.author.username })}
      class="author"
    >
      {view.author.username}
    </a>
    <span class="date">{formatDate(view.article.createdAt)}</span>
  </div>
</div>
