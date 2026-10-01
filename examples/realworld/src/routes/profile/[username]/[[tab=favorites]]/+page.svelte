<script lang="ts">
  /**
   * Profile — a user's info, follow button, and their articles / favourites.
   *
   * Both tabs are URLs: `/profile/:username` and `/profile/:username/favorites`,
   * one route with an optional segment constrained by the `favorites` matcher.
   * The profile read `include`s the user's `followers`, so the follow state
   * comes from the read rather than a scan of every follow row.
   */
  // Aliased: this page already has a `page` of its own — the pagination index.
  import { page as kitPage } from "$app/state";
  import { resolve } from "$app/paths";
  import { AsyncResult } from "effect/reactivity";
  import { useQuery } from "@legation/svelte";
  import {
    allArticles,
    allFavorites,
    allFollows,
    userProfile,
    type Favorite,
    type Follow,
  } from "$lib/domain";
  import { toArticlePage, toProfile, values } from "$lib/joins";
  import { getSession } from "$lib/session.svelte";
  import ArticleList from "$lib/components/ArticleList.svelte";
  import FollowButton from "$lib/components/FollowButton.svelte";
  import type { Feed } from "$lib/types";

  const username = $derived(kitPage.params.username!);
  const favorites = $derived(kitPage.params.tab === "favorites");

  const session = getSession();
  // Reactive thunks: navigating to another profile re-subscribes this read.
  const profileRows = useQuery(() => userProfile(username));
  const articleRows = useQuery(() => allArticles);
  const followRows = useQuery(() => allFollows);
  const favoriteRows = useQuery(() => allFavorites);

  let page = $state(0);

  const isSelf = $derived(session.username === username);
  const profile = $derived(
    toProfile(AsyncResult.getOrElse(profileRows.current, () => []), username, session.username)
  );

  const feed = $derived<Feed>(
    favorites ? { kind: "favorited", username } : { kind: "author", username }
  );

  const articlePage = $derived(
    toArticlePage(
      feed,
      page,
      session.username,
      AsyncResult.getOrElse(articleRows.current, () => []),
      values<Follow>(AsyncResult.getOrElse(followRows.current, () => [])),
      values<Favorite>(AsyncResult.getOrElse(favoriteRows.current, () => []))
    )
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
            <a href={resolve("/settings")} class="btn btn-sm btn-outline-secondary action-btn">
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
              <a class={`nav-link ${!favorites ? "active" : ""}`} href={resolve("/profile/[username]/[[tab=favorites]]", { username: username })}>
                My Articles
              </a>
            </li>
            <li class="nav-item">
              <a
                class={`nav-link ${favorites ? "active" : ""}`}
                href={resolve("/profile/[username]/[[tab=favorites]]", { username: username, tab: "favorites" })}
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
