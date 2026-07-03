<script lang="ts">
  import { browser } from "$app/environment";
  import { setEngineRuntime } from "@legation/svelte";
  import { boot, ssrStub, type AppRuntime } from "../lib/engine.js";

  const { data, children } = $props();

  // The tab's whole data layer is a TabMirror over the service worker's
  // engine — boot broadcasts the config handshake and registers the shell
  // subsets. SSR renders come entirely from the hooks' `initial` seeds, so
  // the server gets a loud stub instead of a runtime.
  let runtime: AppRuntime | undefined;
  if (browser) {
    // svelte-ignore state_referenced_locally
    runtime = boot({ clientGroupId: data.clientGroupId, userId: data.user?.id });
  }
  setEngineRuntime(runtime ?? ssrStub());
</script>

<nav>
  <a href="/">Catalog</a>
  <a href="/cart">Cart</a>
  <a href="/orders">Orders</a>
  {#if data.user}
    <span>signed in as {data.user.name}</span>
    <form method="post" action="/account?/signout" style="display:inline">
      <button>Sign out</button>
    </form>
  {:else}
    <a href="/account">Sign in</a>
  {/if}
</nav>

{@render children()}
