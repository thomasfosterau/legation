<script lang="ts">
  const { data, form } = $props();
</script>

<h1>Account</h1>

{#if data.user}
  <p>Signed in as <strong>{data.user.name}</strong> ({data.user.email}).</p>
  <form method="post" action="?/signout">
    <button>Sign out</button>
  </form>
{:else}
  <!-- Plain form posts: the whole auth flow works with JavaScript disabled. -->
  <h2>Sign in</h2>
  <form method="post" action="?/signin">
    <label>Email <input type="email" name="email" required /></label>
    <label>Password <input type="password" name="password" required /></label>
    <button>Sign in</button>
  </form>

  <h2>Or create an account</h2>
  <form method="post" action="?/signup">
    <label>Name <input name="name" /></label>
    <label>Email <input type="email" name="email" required /></label>
    <label>Password <input type="password" name="password" minlength="8" required /></label>
    <button>Sign up</button>
  </form>

  {#if form?.error}<p>{form.error}</p>{/if}
{/if}
