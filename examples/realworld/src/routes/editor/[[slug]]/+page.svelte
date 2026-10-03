<script lang="ts">
  /**
   * Editor — create or edit an article.
   *
   * One route with an optional param serves both: `/editor` publishes a new
   * article, `/editor/:slug` edits an existing one. The read is a thunk over
   * that param, so it re-subscribes when the URL changes.
   */
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@thomasfosterau/legation-svelte";
  import { getActions } from "$lib/actions.svelte";
  import { getSession } from "$lib/session.svelte";
  import { articleBySlug } from "$lib/domain";
  import { toArticle } from "$lib/joins";

  const actions = getActions();
  const session = getSession();

  const slug = $derived(page.params.slug);
  // `undefined` opts the hook out entirely while creating a new article
  // (#141) — no window registered, no request issued.
  const rows = useQuery(() => (slug === undefined ? undefined : articleBySlug(slug)));
  const existing = $derived(toArticle(AsyncResult.getOrElse(rows.current, () => []), [], null));

  let title = $state("");
  let description = $state("");
  let body = $state("");
  let tagsText = $state("");
  let hydrated = $state(false);

  $effect(() => {
    if (session.username === null) void goto(resolve("/login"));
  });

  // Hydrate the form once the article to edit has loaded.
  $effect(() => {
    if (slug && existing && !hydrated) {
      title = existing.article.title;
      description = existing.article.description;
      body = existing.article.body;
      tagsText = existing.article.tagList.join(" ");
      hydrated = true;
    }
  });

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const current = actions.current;
    if (current === null) return;
    const tagList = tagsText
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (slug && existing) {
      await current.updateArticle(slug, {
        title,
        description,
        body,
        tagList,
        createdAt: existing.article.createdAt,
      });
      await goto(resolve("/article/[slug]", { slug: slug }));
    } else {
      const created = await current.createArticle({ title, description, body, tagList });
      await goto(resolve("/article/[slug]", { slug: created }));
    }
  };
</script>

{#if actions.current === null}
  <div class="editor-page"></div>
{:else}
  <div class="editor-page">
    <div class="container page">
      <div class="row">
        <div class="col-md-10 offset-md-1 col-xs-12">
          <form onsubmit={submit}>
            <fieldset>
              <fieldset class="form-group">
                <input
                  class="form-control form-control-lg"
                  placeholder="Article Title"
                  bind:value={title}
                />
              </fieldset>
              <fieldset class="form-group">
                <input
                  class="form-control"
                  placeholder="What's this article about?"
                  bind:value={description}
                />
              </fieldset>
              <fieldset class="form-group">
                <textarea
                  class="form-control"
                  rows={8}
                  placeholder="Write your article (in markdown)"
                  bind:value={body}
                ></textarea>
              </fieldset>
              <fieldset class="form-group">
                <input
                  class="form-control"
                  placeholder="Enter tags (space separated)"
                  bind:value={tagsText}
                />
              </fieldset>
              <button class="btn btn-lg pull-xs-right btn-primary" type="submit">
                Publish Article
              </button>
            </fieldset>
          </form>
        </div>
      </div>
    </div>
  </div>
{/if}
