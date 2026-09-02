<script lang="ts">
  import { browser } from "$app/environment";
  import { Effect, Fiber, Stream } from "effect";
  import { setClientRuntime } from "@legation/svelte";
  import type { ElectedHost } from "@legation/browser";
  import { boot, bootMainThread, ssrStub, type AppRuntime } from "../lib/engine.js";

  const { data, children } = $props();

  // The tab's whole data layer is a Mirror over the service worker's
  // engine — boot broadcasts the config handshake and registers the shell
  // subsets. SSR renders come entirely from the hooks' `initial` seeds, so
  // the server gets a loud stub instead of a runtime.
  //
  // `?host=main` skips the service worker entirely and runs
  // `ElectedHost.run` on this tab instead (the shipped no-service-worker
  // fallback, ADR-0010/#119) — useful for exercising that topology locally.
  // It is gated on `import.meta.env.DEV` so a production build cannot be
  // switched onto the fallback topology by a query string. `role` below is
  // purely a debug badge; no application logic branches on it.
  let runtime: AppRuntime | undefined;
  let role = $state<ElectedHost.Role | undefined>(undefined);
  if (browser) {
    const useMainThreadHost =
      import.meta.env.DEV && new URLSearchParams(location.search).get("host") === "main";
    if (useMainThreadHost) {
      // svelte-ignore state_referenced_locally
      const elected = bootMainThread({ clientGroupId: data.clientGroupId, userId: data.user?.id });
      runtime = elected.runtime;
      const fiber = Effect.runFork(Stream.runForEach(elected.role, (r) => Effect.sync(() => (role = r))));
      $effect(() => () => Effect.runFork(Fiber.interrupt(fiber)));
    } else {
      // svelte-ignore state_referenced_locally
      runtime = boot({ clientGroupId: data.clientGroupId, userId: data.user?.id });
    }
  }
  setClientRuntime(runtime ?? ssrStub());
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
  {#if role !== undefined}
    <span title="ElectedHost.run dev toggle (?host=main) — debug only">host role: {role}</span>
  {/if}
</nav>

{@render children()}
