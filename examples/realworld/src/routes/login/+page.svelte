<script lang="ts">
  /**
   * Login — Sign in.
   */
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { getSession } from "#lib/session.svelte.js";

  const session = getSession();

  let username = $state("");
  let password = $state("");
  let error = $state<string | null>(null);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const err = session.login(username.trim(), password);
    if (err) error = err;
    else void goto(resolve("/"));
  };
</script>

<div class="auth-page">
  <div class="container page">
    <div class="row">
      <div class="col-md-6 offset-md-3 col-xs-12">
        <h1 class="text-xs-center">Sign in</h1>
        <p class="text-xs-center">
          <a href={resolve("/register")}>Need an account?</a>
        </p>
        <p class="text-xs-center text-muted">Try emma / demo or liang / demo.</p>
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
            <input
              class="form-control form-control-lg"
              type="password"
              placeholder="Password"
              bind:value={password}
            />
          </fieldset>
          <button class="btn btn-lg btn-primary pull-xs-right" type="submit">Sign in</button>
        </form>
      </div>
    </div>
  </div>
</div>
