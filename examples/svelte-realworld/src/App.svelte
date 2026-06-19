<script lang="ts">
  /**
   * App shell — header nav, route switch, footer, and a sync status banner.
   *
   * The root wires the engine runtime + demo world into context, builds the
   * base collection stores (`data`) and the session (`auth`), and keeps the
   * server identity + localStorage in lock-step with the session. The header
   * reflects the live session; the banner reflects the live transport status
   * and lets you toggle offline to watch writes queue in the durable journal and
   * flush on reconnect.
   */
  import { untrack } from "svelte";
  import { setEngineRuntime, getMutate } from "@thomasfosterau/effect-sync-svelte";
  import type { World } from "./sync";
  import { setWorld, connectionStore } from "./world";
  import { createData, setData } from "./data";
  import { createAuth, setAuth, bindIdentity } from "./auth";
  import { currentRoute, hrefFor } from "./router";
  import Home from "./pages/Home.svelte";
  import Login from "./pages/Login.svelte";
  import Register from "./pages/Register.svelte";
  import Settings from "./pages/Settings.svelte";
  import Editor from "./pages/Editor.svelte";
  import Article from "./pages/Article.svelte";
  import Profile from "./pages/Profile.svelte";

  const props: { world: World } = $props();
  // `world` is a stable singleton built once by createWorld; read it untracked
  // so the one-time context wiring below isn't flagged as reactive state.
  const world = untrack(() => props.world);

  // Wire the engine runtime + demo world into context for this subtree.
  setEngineRuntime(world.runtime);
  setWorld(world);

  // Base collection stores + the session, shared via context.
  const data = createData();
  setData(data);

  const mutate = getMutate();
  const { auth, currentUsername } = createAuth(data.users, mutate, world);
  setAuth(auth);

  // Keep the server identity + localStorage in lock-step with the session.
  $effect(() => bindIdentity(currentUsername, world));

  const connection = connectionStore(world);
  const { currentUser } = auth;

  const offline = $derived($connection === "disconnected");
  const active = (name: string): string => ($currentRoute.name === name ? "active" : "");
</script>

<div
  style="background: {offline ? '#b85c00' : '#3c4048'}; color: #fff; font-size: 13px; padding: 5px 0;"
>
  <div class="container" style="display: flex; justify-content: space-between;">
    <span>
      effect-sync · in-page SyncServer + MemoryBackend ·
      {offline ? "offline — writes queue in the journal" : "online — optimistic + rebase"}
    </span>
    <button
      style="background: transparent; border: 1px solid rgba(255,255,255,0.5); color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; padding: 1px 8px;"
      onclick={() => void world.setOnline(offline)}
    >
      {offline ? "Go online" : "Go offline"}
    </button>
  </div>
</div>

<nav class="navbar navbar-light">
  <div class="container">
    <a href={hrefFor({ name: "home" })} class="navbar-brand">conduit</a>
    <ul class="nav navbar-nav pull-xs-right">
      <li class="nav-item">
        <a href={hrefFor({ name: "home" })} class={`nav-link ${active("home")}`}>Home</a>
      </li>
      {#if $currentUsername}
        <li class="nav-item">
          <a href={hrefFor({ name: "editor" })} class={`nav-link ${active("editor")}`}>
            <i class="ion-compose"></i>&nbsp;New Article
          </a>
        </li>
        <li class="nav-item">
          <a href={hrefFor({ name: "settings" })} class={`nav-link ${active("settings")}`}>
            <i class="ion-gear-a"></i>&nbsp;Settings
          </a>
        </li>
        <li class="nav-item">
          <a
            href={hrefFor({ name: "profile", username: $currentUsername, favorites: false })}
            class={`nav-link ${active("profile")}`}
          >
            {#if $currentUser?.image}
              <img src={$currentUser.image} class="user-pic" alt={$currentUsername} />
            {/if}
            {$currentUsername}
          </a>
        </li>
      {:else}
        <li class="nav-item">
          <a href={hrefFor({ name: "login" })} class={`nav-link ${active("login")}`}>Sign in</a>
        </li>
        <li class="nav-item">
          <a href={hrefFor({ name: "register" })} class={`nav-link ${active("register")}`}>Sign up</a>
        </li>
      {/if}
    </ul>
  </div>
</nav>

{#if $currentRoute.name === "home"}
  <Home />
{:else if $currentRoute.name === "login"}
  <Login />
{:else if $currentRoute.name === "register"}
  <Register />
{:else if $currentRoute.name === "settings"}
  <Settings />
{:else if $currentRoute.name === "editor"}
  <Editor slug={$currentRoute.slug} />
{:else if $currentRoute.name === "article"}
  <Article slug={$currentRoute.slug} />
{:else if $currentRoute.name === "profile"}
  <Profile username={$currentRoute.username} favorites={$currentRoute.favorites} />
{/if}

<footer>
  <div class="container">
    <a href={hrefFor({ name: "home" })} class="logo-font">conduit</a>
    <span class="attribution">
      RealWorld example driving the
      <a href="https://github.com/thomasfosterau/effect-synchronizer">effect-sync</a> engine.
    </span>
  </div>
</footer>
