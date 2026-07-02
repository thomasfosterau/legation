<script lang="ts">
  /**
   * App shell — a tabbed admin dashboard over the Northwind collections, with a
   * sync status banner whose offline toggle makes writes queue in the journal.
   *
   * The root wires the engine runtime + demo world into context and builds the
   * base collection stores (`data`), shared via context so every tab reads the
   * same live stores. The banner reflects the live transport status.
   */
  import { untrack } from "svelte";
  import { setEngineRuntime } from "@legation/svelte";
  import type { World } from "./sync";
  import { setWorld, connectionStore } from "./world";
  import { createData, setData } from "./data";
  import Products from "./pages/Products.svelte";
  import Categories from "./pages/Categories.svelte";
  import Orders from "./pages/Orders.svelte";
  import Customers from "./pages/Customers.svelte";
  import Suppliers from "./pages/Suppliers.svelte";
  import "./styles.css";

  type Tab = "products" | "categories" | "orders" | "customers" | "suppliers";
  const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: "products", label: "Products" },
    { id: "categories", label: "Categories" },
    { id: "orders", label: "Orders" },
    { id: "customers", label: "Customers" },
    { id: "suppliers", label: "Suppliers" },
  ];

  const props: { world: World } = $props();
  // `world` is a stable singleton built once by createWorld; read it untracked
  // so the one-time context wiring below isn't flagged as reactive state.
  const world = untrack(() => props.world);

  // Wire the engine runtime + demo world into context for this subtree.
  setEngineRuntime(world.runtime);
  setWorld(world);

  // Base collection stores, shared via context.
  setData(createData());

  const connection = connectionStore(world);
  const offline = $derived($connection === "disconnected");

  let tab = $state<Tab>("products");
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
  <div class="tabs">
    {#each TABS as t (t.id)}
      <button class={`tab ${tab === t.id ? "active" : ""}`} onclick={() => (tab = t.id)}>
        {t.label}
      </button>
    {/each}
  </div>

  {#if tab === "products"}
    <Products />
  {:else if tab === "categories"}
    <Categories />
  {:else if tab === "orders"}
    <Orders />
  {:else if tab === "customers"}
    <Customers />
  {:else if tab === "suppliers"}
    <Suppliers />
  {/if}
</div>
