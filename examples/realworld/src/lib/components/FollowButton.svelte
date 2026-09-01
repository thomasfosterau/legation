<script lang="ts">
  import { goto } from "$app/navigation";
  import { getActions } from "../actions.svelte";
  import { getSession } from "../session.svelte";
  import { paths } from "../routes";
  import type { ProfileView } from "../types";

  let { profile }: { profile: ProfileView } = $props();

  const actions = getActions();
  const session = getSession();

  const onClick = (): void => {
    const current = actions.current;
    if (current === null) return void goto(paths.login);
    void current.setFollow(profile.username, !profile.following);
  };
</script>

{#if session.username !== profile.username}
  <button
    class={`btn btn-sm ${profile.following ? "btn-secondary" : "btn-outline-secondary"}`}
    onclick={onClick}
  >
    <i class="ion-plus-round"></i>
    {profile.following ? "Unfollow" : "Follow"}
    {profile.username}
  </button>
{/if}
