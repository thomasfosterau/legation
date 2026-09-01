<script lang="ts">
  import { paths } from "../routes";
  import type { ArticleView } from "../types";

  let { view }: { view: ArticleView } = $props();

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
</script>

<div class="article-meta">
  <a href={paths.profile(view.author.username)}>
    <img src={view.author.image} alt={view.author.username} />
  </a>
  <div class="info">
    <a
      href={paths.profile(view.author.username)}
      class="author"
    >
      {view.author.username}
    </a>
    <span class="date">{formatDate(view.article.createdAt)}</span>
  </div>
</div>
