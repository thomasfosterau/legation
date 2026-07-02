<script lang="ts">
  /**
   * Article — full article, author actions, follow/favourite, and comments.
   */
  import { getActions } from "../actions";
  import { getAuth } from "../auth";
  import { getData } from "../data";
  import { toArticle, toComments } from "../joins";
  import ArticleMeta from "../components/ArticleMeta.svelte";
  import FavoriteButton from "../components/FavoriteButton.svelte";
  import FollowButton from "../components/FollowButton.svelte";
  import { hrefFor, navigate } from "../router";

  let { slug }: { slug: string } = $props();

  const { currentUsername } = getAuth();
  const actions = getActions();
  const { users, articles, commentsWithAuthor, follows, favorites } = getData();

  const view = $derived(
    toArticle(slug, $currentUsername, $articles, $users, $follows, $favorites)
  );
  const commentViews = $derived(toComments(slug, $commentsWithAuthor));

  let draft = $state("");

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  const submitComment = (event: SubmitEvent): void => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0 || $actions === null || view === undefined) return;
    void $actions.addComment(view.article.slug, body);
    draft = "";
  };
</script>

{#if view === undefined}
  <div class="article-page">
    <div class="container page">Loading article…</div>
  </div>
{:else}
  {@const isAuthor = $currentUsername === view.author.username}
  <div class="article-page">
    <div class="banner">
      <div class="container">
        <h1>{view.article.title}</h1>
        <div class="article-meta">
          <ArticleMeta {view} />
          {#if isAuthor}
            <span>
              <a
                href={hrefFor({ name: "editor", slug: view.article.slug })}
                class="btn btn-sm btn-outline-secondary"
              >
                <i class="ion-edit"></i> Edit Article
              </a>
              <button
                class="btn btn-sm btn-outline-danger"
                onclick={() => {
                  void $actions?.deleteArticle(view.article.slug);
                  navigate({ name: "home" });
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
                href={hrefFor({ name: "editor", slug: view.article.slug })}
                class="btn btn-sm btn-outline-secondary"
              >
                <i class="ion-edit"></i> Edit Article
              </a>
              <button
                class="btn btn-sm btn-outline-danger"
                onclick={() => {
                  void $actions?.deleteArticle(view.article.slug);
                  navigate({ name: "home" });
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
          {#if $currentUsername}
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
              <a href={hrefFor({ name: "login" })}>Sign in</a> or
              <a href={hrefFor({ name: "register" })}>sign up</a> to add comments.
            </p>
          {/if}

          {#each commentViews as { comment, author } (comment.id)}
            <div class="card">
              <div class="card-block">
                <p class="card-text">{comment.body}</p>
              </div>
              <div class="card-footer">
                <a
                  href={hrefFor({ name: "profile", username: author.username, favorites: false })}
                  class="comment-author"
                >
                  <img src={author.image} class="comment-author-img" alt={author.username} />
                </a>
                <a
                  href={hrefFor({ name: "profile", username: author.username, favorites: false })}
                  class="comment-author"
                >
                  {author.username}
                </a>
                <span class="date-posted">{formatDate(comment.createdAt)}</span>
                {#if $currentUsername === author.username}
                  <span class="mod-options">
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                    <i class="ion-trash-a" onclick={() => void $actions?.deleteComment(comment.id)}
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
