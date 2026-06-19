<script lang="ts">
  /**
   * Profile — a user's info, follow button, and their articles / favourites.
   */
  import { getAuth } from "../auth";
  import { getData } from "../data";
  import { toArticlePage, toProfile } from "../joins";
  import ArticleList from "../components/ArticleList.svelte";
  import FollowButton from "../components/FollowButton.svelte";
  import { hrefFor } from "../router";
  import type { Feed } from "../types";

  let { username, favorites }: { username: string; favorites: boolean } = $props();

  const { currentUsername } = getAuth();
  const data = getData();
  const { users, articles, follows } = data;
  const favoritesStore = data.favorites;

  let page = $state(0);

  const isSelf = $derived($currentUsername === username);
  const profile = $derived(toProfile(username, $users, $follows, $currentUsername));

  const feed = $derived<Feed>(
    favorites
      ? { kind: "favorited", username }
      : { kind: "author", username }
  );

  const articlePage = $derived(
    toArticlePage(feed, page, $currentUsername, $articles, $users, $follows, $favoritesStore)
  );

  // Reset to the first page whenever the profile or tab changes.
  $effect(() => {
    void username;
    void favorites;
    page = 0;
  });
</script>

<div class="profile-page">
  <div class="user-info">
    <div class="container">
      <div class="row">
        <div class="col-xs-12 col-md-10 offset-md-1">
          <img src={profile.image} class="user-img" alt={profile.username} />
          <h4>{profile.username}</h4>
          <p>{profile.bio}</p>
          {#if isSelf}
            <a href={hrefFor({ name: "settings" })} class="btn btn-sm btn-outline-secondary action-btn">
              <i class="ion-gear-a"></i> Edit Profile Settings
            </a>
          {:else}
            <span class="action-btn">
              <FollowButton {profile} />
            </span>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="row">
      <div class="col-xs-12 col-md-10 offset-md-1">
        <div class="articles-toggle">
          <ul class="nav nav-pills outline-active">
            <li class="nav-item">
              <a
                class={`nav-link ${!favorites ? "active" : ""}`}
                href={`#/profile/${encodeURIComponent(username)}`}
              >
                My Articles
              </a>
            </li>
            <li class="nav-item">
              <a
                class={`nav-link ${favorites ? "active" : ""}`}
                href={`#/profile/${encodeURIComponent(username)}/favorites`}
              >
                Favorited Articles
              </a>
            </li>
          </ul>
        </div>
        <ArticleList page={articlePage} pageIndex={page} onPage={(p) => (page = p)} />
      </div>
    </div>
  </div>
</div>
