<script lang="ts">
  import { browser } from "$app/environment";
  import { setEngineRuntime } from "@legation/svelte";
  import { boot, ssrStub, startSync, type AppRuntime } from "../lib/engine.js";
  import { registerServiceWorker } from "../lib/sw.js";

  const { data, children } = $props();

  // Boot once per app lifetime: IndexedDB store (snapshot hydrates only when
  // empty), WS transport with HTTP fallback. On the server, hooks render from
  // the snapshot via their `initial` seeds — no runtime needed there, but the
  // context must exist, so provide a lazy one-time boot.
  let runtime: AppRuntime | undefined;
  if (browser) {
  // svelte-ignore state_referenced_locally
  runtime = boot({ snapshot: data.snapshot, clientGroupId: data.clientGroupId });
    startSync(runtime);
    registerServiceWorker();
  }
  // SSR renders never run $effect, so hooks only read `initial` seeds — a
  // server-side runtime is never exercised; the stub makes any misuse loud.
  setEngineRuntime(runtime ?? ssrStub());
</script>

<nav>
  <a href="/">Catalog</a>
  <a href="/cart">Cart</a>
  <a href="/orders">Orders</a>
  {#if data.userId}
    <span>signed in as {data.userId}</span>
    <form method="post" action="/account?/signout" style="display:inline">
      <button>Sign out</button>
    </form>
  {:else}
    <a href="/account">Sign in</a>
  {/if}
</nav>

{@render children()}
