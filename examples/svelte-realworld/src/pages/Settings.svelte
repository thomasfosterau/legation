<script lang="ts">
  /**
   * Settings — edit the current user's profile, or log out.
   */
  import { getAuth } from "../auth";
  import { navigate } from "../router";

  const { currentUser, updateSettings, logout } = getAuth();

  // Snapshot the user once for the form fields (React seeds state from the user).
  const initial = $currentUser;
  let image = $state(initial?.image ?? "");
  const username = initial?.username ?? "";
  let bio = $state(initial?.bio ?? "");
  let email = $state(initial?.email ?? "");
  let password = $state(initial?.password ?? "");

  $effect(() => {
    if ($currentUser === null) navigate({ name: "login" });
  });

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    await updateSettings({ username, email, password, bio, image });
    navigate({ name: "profile", username, favorites: false });
  };
</script>

{#if $currentUser === null}
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
              logout();
              navigate({ name: "home" });
            }}
          >
            Or click here to logout.
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
