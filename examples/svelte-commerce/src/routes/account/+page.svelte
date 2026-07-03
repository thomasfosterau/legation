<script lang="ts">
  const { data, form } = $props();
</script>

<h1>Account</h1>

{#if data.userId}
  <p>Signed in as <strong>{data.userId}</strong>.</p>
  <form method="post" action="?/signout">
    <button>Sign out</button>
  </form>
{:else}
  <!-- A plain form post: works with JavaScript disabled. -->
  <form method="post" action="?/signin">
    <label>Username <input name="username" required /></label>
    <button>Sign in</button>
  </form>
  {#if form?.error}<p>{form.error}</p>{/if}
{/if}
