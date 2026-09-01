<script lang="ts">
  /**
   * App shell — an admin dashboard over the Northwind collections, with a sync
   * status banner whose offline toggle makes writes queue in the journal.
   *
   * The root wires the engine runtime + demo world into context and builds the
   * base collection stores (`data`), shared via context so every screen reads
   * the same live stores. The banner reflects the live transport status.
   *
   * The five screens are five routes: the nav is plain links, SvelteKit renders
   * the match through `{@render children()}`, and the URL is the app's state —
   * reload or deep-link straight into Orders and you land where you left off.
   */
  import { page } from "$app/state";
  import { Runtime } from "@legation/svelte";
  import { DevtoolsPanel } from "@legation/devtools/svelte";
  import { setWorld, connectionStore } from "$lib/world";
  import { createData, setData } from "$lib/data";
  import "../app.css";

  const TABS = [
    { href: "/products", label: "Products" },
    { href: "/categories", label: "Categories" },
    { href: "/orders", label: "Orders" },
    { href: "/customers", label: "Customers" },
    { href: "/suppliers", label: "Suppliers" },
  ] as const;

  const { data: pageData, children } = $props();
  // The world is a stable singleton the root `load` builds once, so reading it
  // at init — rather than through a closure — is exactly what's wanted here.
  // svelte-ignore state_referenced_locally
  const world = pageData.world;

  // Wire the engine runtime + demo world into context for this subtree.
  Runtime.setEngineRuntime(world.runtime);
  setWorld(world);

  // Base collection stores, shared via context.
  setData(createData());

  const connection = connectionStore(world);
  const offline = $derived($connection === "disconnected");
</script>

<div class={`banner ${offline ? "offline" : ""}`}>
  <span class="muted">
    legation · Northwind · in-page SyncServer + MemoryBackend ·
    {offline ? "offline — edits queue in the journal" : "online — optimistic + rebase"}
  </span>
  <button onclick={() => void world.setOnline(offline)}>
    {offline ? "Go online" : "Go offline"}
  </button>
</div>

<div class="shell">
  <h1 class="title">Northwind Traders</h1>
  <p class="subtitle">
    A relational admin dashboard — seven collections joined live over the mirror, optimistic edits,
    push/pull/rebase.
  </p>
  <nav class="tabs">
    {#each TABS as tab (tab.href)}
      <a class={`tab ${page.url.pathname === tab.href ? "active" : ""}`} href={tab.href}>
        {tab.label}
      </a>
    {/each}
  </nav>

  {@render children()}

  <DevtoolsPanel core={world.devtools} />
</div>
