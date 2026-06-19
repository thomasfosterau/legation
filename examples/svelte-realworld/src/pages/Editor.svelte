<script lang="ts">
  /**
   * Editor — create or edit an article.
   */
  import { getActions } from "../actions";
  import { getAuth } from "../auth";
  import { getData } from "../data";
  import { toArticle } from "../joins";
  import { navigate } from "../router";

  let { slug }: { slug?: string } = $props();

  const actions = getActions();
  const { currentUsername } = getAuth();
  const { users, articles, follows, favorites } = getData();

  const existing = $derived(
    toArticle(slug ?? "", $currentUsername, $articles, $users, $follows, $favorites)
  );

  let title = $state("");
  let description = $state("");
  let body = $state("");
  let tagsText = $state("");
  let hydrated = $state(false);

  $effect(() => {
    if ($currentUsername === null) navigate({ name: "login" });
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
    if ($actions === null) return;
    const tagList = tagsText
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (slug && existing) {
      await $actions.updateArticle(slug, {
        title,
        description,
        body,
        tagList,
        createdAt: existing.article.createdAt,
      });
      navigate({ name: "article", slug });
    } else {
      const created = await $actions.createArticle({ title, description, body, tagList });
      navigate({ name: "article", slug: created });
    }
  };
</script>

{#if $actions === null}
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
