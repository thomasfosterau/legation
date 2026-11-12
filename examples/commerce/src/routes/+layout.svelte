<script lang="ts">
  import { browser } from "$app/env";
  import * as Effect from "effect/Effect";
  import * as Fiber from "effect/Fiber";
  import * as Option from "effect/Option";
  import * as Stream from "effect/Stream";
  import { type ClientHandle, fromRuntime, setClient } from "@thomasfosterau/legation-svelte";
  import type { ElectedHost } from "@thomasfosterau/legation-browser";
  import { boot, bootMainThread } from "../lib/engine.js";

  const { data, children } = $props();

  // The tab's whole data layer is a Mirror over the service worker's
  // engine — boot broadcasts the config handshake, offers the worker the
  // page's SSR snapshot (#146; the worker hydrates an empty replica with it)
  // and registers the shell subsets. SSR renders come entirely from the
  // hooks' `initial` seeds (the catalog's from that snapshot), so the server
  // gets no Client: a hook that reached for one there would fail.
  //
  // `?host=main` skips the service worker entirely and runs
  // `ElectedHost.run` on this tab instead (the shipped no-service-worker
  // fallback, ADR-0010/#119) — useful for exercising that topology locally.
  // It is gated on `import.meta.env.DEV` so a production build cannot be
  // switched onto the fallback topology by a query string. `role` below is
  // purely a debug badge; no application logic branches on it, and neither
  // does `hydration` (what the worker answered the snapshot, shown on the
  // nav for the browser test and the curious).
  let client: ClientHandle | undefined;
  let role = $state<ElectedHost.Role | undefined>(undefined);
  let hydration = $state("pending");
  if (browser) {
    const useMainThreadHost =
      import.meta.env.DEV && new URLSearchParams(location.search).get("host") === "main";
    if (useMainThreadHost) {
      // svelte-ignore state_referenced_locally
      const elected = bootMainThread({ clientGroupId: data.clientGroupId, userId: data.user?.id });
      client = fromRuntime(elected.runtime);
      hydration = "none";
      const fiber = Effect.runFork(Stream.runForEach(elected.role, (r) => Effect.sync(() => (role = r))));
      $effect(() => () => Effect.runFork(Fiber.interrupt(fiber)));
    } else {
      // svelte-ignore state_referenced_locally
      const connected = boot({
        clientGroupId: data.clientGroupId,
        userId: data.user?.id,
        snapshot: data.snapshot,
      });
      client = connected;
      void connected.hydration.then((outcome) => {
        hydration = Option.match(outcome, {
          onNone: () => "none",
          onSome: ({ hydrated, reason }) => (hydrated ? "hydrated" : (reason ?? "declined")),
        });
      });
    }
  }
  setClient(client);
</script>

<nav data-hydration={hydration} data-snapshot-cookie={data.snapshot?.cookie ?? ""}>
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
