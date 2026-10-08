<script lang="ts">
  /**
   * Settings — edit the current user's profile, or log out.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { getSession } from "#lib/session.svelte.js";

  const session = getSession();

  // Snapshot the user once for the form fields.
  // svelte-ignore state_referenced_locally
  const initial = session.user;
  let image = $state(initial?.image ?? "");
  const username = initial?.username ?? "";
  let bio = $state(initial?.bio ?? "");
  let email = $state(initial?.email ?? "");
  let password = $state(initial?.password ?? "");

  $effect(() => {
    if (session.user === null) void goto(resolve("/login"));
  });

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    await session.updateSettings({ username, email, password, bio, image });
    await goto(resolve("/profile/[username]/[[tab=favorites]]", { username: username }));
  };
</script>

{#if session.user === null}
  <div class="settings-page"></div>
{:else}
  <div class="settings-page">
    <div class="container page">
      <div class="row">
        <div class="col-md-6 offset-md-3 col-xs-12">
          <h1 class="text-xs-center">Your Settings</h1>
          <form onsubmit={submit}>
            <fieldset>
              <fieldset class="form-group">
                <input
                  class="form-control"
                  placeholder="URL of profile picture"
                  bind:value={image}
                />
              </fieldset>
              <fieldset class="form-group">
                <input class="form-control form-control-lg" value={username} disabled />
              </fieldset>
              <fieldset class="form-group">
                <textarea
                  class="form-control form-control-lg"
                  rows={8}
                  placeholder="Short bio about you"
                  bind:value={bio}
                ></textarea>
              </fieldset>
              <fieldset class="form-group">
                <input class="form-control form-control-lg" placeholder="Email" bind:value={email} />
              </fieldset>
              <fieldset class="form-group">
                <input
                  class="form-control form-control-lg"
                  type="password"
                  placeholder="New Password"
                  bind:value={password}
                />
              </fieldset>
              <button class="btn btn-lg btn-primary pull-xs-right" type="submit">
                Update Settings
              </button>
            </fieldset>
          </form>
          <hr />
          <button
            class="btn btn-outline-danger"
            onclick={() => {
              session.logout();
              void goto(resolve("/"));
            }}
          >
            Or click here to logout.
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
