<script lang="ts">
  /**
   * Article — full article, author actions, follow/favourite, and comments.
   *
   * Two reads, both joined by the engine and both reactive on the slug: the
   * article with its `author` and `favorites`, and its comments with each
   * comment's `author`. Navigating between two articles re-subscribes both
   * while the previous rows stay on screen.
   */
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { AsyncResult } from "effect/unstable/reactivity";
  import { useQuery } from "@legation/svelte";
  import { getActions } from "$lib/actions.svelte";
  import { getSession } from "$lib/session.svelte";
  import { allFollows, articleBySlug, articleComments, type Follow } from "$lib/domain";
  import { toArticle, toComments, values } from "$lib/joins";
  import ArticleMeta from "$lib/components/ArticleMeta.svelte";
  import FavoriteButton from "$lib/components/FavoriteButton.svelte";
  import FollowButton from "$lib/components/FollowButton.svelte";

  const slug = $derived(page.params.slug!);

  const session = getSession();
  const actions = getActions();
  const articleRows = useQuery(() => articleBySlug(slug));
  const commentRows = useQuery(() => articleComments(slug));
  const followRows = useQuery(() => allFollows);

  const view = $derived(
    toArticle(
      AsyncResult.getOrElse(articleRows.current, () => []),
      values<Follow>(AsyncResult.getOrElse(followRows.current, () => [])),
      session.username
    )
  );
  const commentViews = $derived(toComments(AsyncResult.getOrElse(commentRows.current, () => [])));

  let draft = $state("");

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  const submitComment = (event: SubmitEvent): void => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0 || actions.current === null || view === undefined) return;
    void actions.current.addComment(view.article.slug, body);
    draft = "";
  };
</script>

{#if view === undefined}
  <div class="article-page">
    <div class="container page">Loading article…</div>
  </div>
{:else}
  {@const isAuthor = session.username === view.author.username}
  <div class="article-page">
    <div class="banner">
      <div class="container">
        <h1>{view.article.title}</h1>
        <div class="article-meta">
          <ArticleMeta {view} />
          {#if isAuthor}
            <span>
              <a
                href={resolve("/editor/[[slug]]", { slug: view.article.slug })}
                class="btn btn-sm btn-outline-secondary"
              >
                <i class="ion-edit"></i> Edit Article
              </a>
              <button
                class="btn btn-sm btn-outline-danger"
                onclick={() => {
                  void actions.current?.deleteArticle(view.article.slug);
                  void goto(resolve("/"));
                }}
              >
                <i class="ion-trash-a"></i> Delete Article
              </button>
            </span>
          {:else}
            <span>
              <FollowButton profile={view.author} /> <FavoriteButton article={view} />
            </span>
          {/if}
        </div>
      </div>
    </div>

    <div class="container page">
      <div class="row article-content">
        <div class="col-md-12">
          <p style="white-space: pre-wrap">{view.article.body}</p>
          <ul class="tag-list">
            {#each view.article.tagList as tag (tag)}
              <li class="tag-default tag-pill tag-outline">{tag}</li>
            {/each}
          </ul>
        </div>
      </div>

      <hr />

      <div class="article-actions">
        <div class="article-meta">
          <ArticleMeta {view} />
          {#if isAuthor}
            <span>
              <a
                href={resolve("/editor/[[slug]]", { slug: view.article.slug })}
                class="btn btn-sm btn-outline-secondary"
              >
                <i class="ion-edit"></i> Edit Article
              </a>
              <button
                class="btn btn-sm btn-outline-danger"
                onclick={() => {
                  void actions.current?.deleteArticle(view.article.slug);
                  void goto(resolve("/"));
                }}
              >
                <i class="ion-trash-a"></i> Delete Article
              </button>
            </span>
          {:else}
            <span>
              <FollowButton profile={view.author} /> <FavoriteButton article={view} />
            </span>
          {/if}
        </div>
      </div>

      <div class="row">
        <div class="col-xs-12 col-md-8 offset-md-2">
          {#if session.username}
            <form class="card comment-form" onsubmit={submitComment}>
              <div class="card-block">
                <textarea
                  class="form-control"
                  placeholder="Write a comment..."
                  rows={3}
                  bind:value={draft}
                ></textarea>
              </div>
              <div class="card-footer">
                <button class="btn btn-sm btn-primary" type="submit">Post Comment</button>
              </div>
            </form>
          {:else}
            <p>
              <a href={resolve("/login")}>Sign in</a> or
              <a href={resolve("/register")}>sign up</a> to add comments.
            </p>
          {/if}

          {#each commentViews as { comment, author } (comment.id)}
            <div class="card">
              <div class="card-block">
                <p class="card-text">{comment.body}</p>
              </div>
              <div class="card-footer">
                <a href={resolve("/profile/[username]/[[tab=favorites]]", { username: author.username })} class="comment-author">
                  <img src={author.image} class="comment-author-img" alt={author.username} />
                </a>
                <a href={resolve("/profile/[username]/[[tab=favorites]]", { username: author.username })} class="comment-author">
                  {author.username}
                </a>
                <span class="date-posted">{formatDate(comment.createdAt)}</span>
                {#if session.username === author.username}
                  <span class="mod-options">
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                    <i
                      class="ion-trash-a"
                      onclick={() => void actions.current?.deleteComment(comment.id)}
                    ></i>
                  </span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}
