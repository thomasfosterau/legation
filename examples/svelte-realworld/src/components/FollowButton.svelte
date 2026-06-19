<script lang="ts">
  import { getActions } from "../actions";
  import { getAuth } from "../auth";
  import { navigate } from "../router";
  import type { ProfileView } from "../types";

  let { profile }: { profile: ProfileView } = $props();

  const actions = getActions();
  const { currentUsername } = getAuth();

  const onClick = (): void => {
    if ($actions === null) return navigate({ name: "login" });
    void $actions.setFollow(profile.username, !profile.following);
  };
</script>

{#if $currentUsername !== profile.username}
  <button
    class={`btn btn-sm ${profile.following ? "btn-secondary" : "btn-outline-secondary"}`}
    onclick={onClick}
  >
    <i class="ion-plus-round"></i>
    {profile.following ? "Unfollow" : "Follow"}
    {profile.username}
  </button>
{/if}
