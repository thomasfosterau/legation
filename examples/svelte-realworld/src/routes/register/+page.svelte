<script lang="ts">
  /**
   * Register — Sign up.
   */
  import { goto } from "$app/navigation";
  import { getAuth } from "$lib/auth";
  import { paths } from "$lib/routes";

  const { register } = getAuth();

  let username = $state("");
  let email = $state("");
  let password = $state("");
  let error = $state<string | null>(null);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const err = await register(username.trim(), email.trim(), password);
    if (err) error = err;
    else await goto(paths.home);
  };
</script>

<div class="auth-page">
  <div class="container page">
    <div class="row">
      <div class="col-md-6 offset-md-3 col-xs-12">
        <h1 class="text-xs-center">Sign up</h1>
        <p class="text-xs-center">
          <a href={paths.login}>Have an account?</a>
        </p>
        {#if error}
          <ul class="error-messages">
            <li>{error}</li>
          </ul>
        {/if}
        <form onsubmit={submit}>
          <fieldset class="form-group">
            <input class="form-control form-control-lg" placeholder="Username" bind:value={username} />
          </fieldset>
          <fieldset class="form-group">
            <input class="form-control form-control-lg" placeholder="Email" bind:value={email} />
          </fieldset>
          <fieldset class="form-group">
            <input
              class="form-control form-control-lg"
              type="password"
              placeholder="Password"
              bind:value={password}
            />
          </fieldset>
          <button class="btn btn-lg btn-primary pull-xs-right" type="submit">Sign up</button>
        </form>
      </div>
    </div>
  </div>
</div>
