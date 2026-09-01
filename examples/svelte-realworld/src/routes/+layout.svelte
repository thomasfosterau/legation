<script lang="ts">
  /**
   * App shell — header nav, sync status banner, and the footer.
   *
   * The root wires the engine runtime + demo world into context, builds the
   * base collection stores (`data`) and the session (`auth`), and keeps the
   * server identity + localStorage in lock-step with the session. The header
   * reflects the live session; the banner reflects the live transport status
   * and lets you toggle offline to watch writes queue in the durable journal and
   * flush on reconnect.
   *
   * Everything between the header and the footer is SvelteKit's own router:
   * `{@render children()}` renders whichever `+page.svelte` under `src/routes`
   * matches the URL.
   */
  import { page } from "$app/state";
  import { Runtime, Mutation } from "@legation/svelte";
  import { setWorld, connectionStore } from "$lib/world";
  import { createData, setData } from "$lib/data";
  import { createAuth, setAuth, bindIdentity } from "$lib/auth";
  import { paths } from "$lib/routes";

  const { data: pageData, children } = $props();
  // The world is a stable singleton the root `load` builds once, so reading it
  // at init — rather than through a closure — is exactly what's wanted here.
  // svelte-ignore state_referenced_locally
  const world = pageData.world;

  // Wire the engine runtime + demo world into context for this subtree.
  Runtime.setEngineRuntime(world.runtime);
  setWorld(world);

  // Base collection stores + the session, shared via context.
  const data = createData();
  setData(data);

  const mutate = Mutation.getMutate();
  const { auth, currentUsername } = createAuth(data.users, mutate, world);
  setAuth(auth);

  // Keep the server identity + localStorage in lock-step with the session.
  $effect(() => bindIdentity(currentUsername, world));

  const connection = connectionStore(world);
  const { currentUser } = auth;

  const offline = $derived($connection === "disconnected");
  // Nav highlighting reads the live URL rather than a route union of our own.
  const active = (prefix: string): string =>
    (prefix === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(prefix))
      ? "active"
      : "";
</script>

<div
  style="background: {offline ? '#b85c00' : '#3c4048'}; color: #fff; font-size: 13px; padding: 5px 0;"
>
  <div class="container" style="display: flex; justify-content: space-between;">
    <span>
      legation · in-page SyncServer + MemoryBackend ·
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
    <a href={paths.home} class="navbar-brand">conduit</a>
    <ul class="nav navbar-nav pull-xs-right">
      <li class="nav-item">
        <a href={paths.home} class={`nav-link ${active("/")}`}>Home</a>
      </li>
      {#if $currentUsername}
        <li class="nav-item">
          <a href={paths.newArticle} class={`nav-link ${active("/editor")}`}>
            <i class="ion-compose"></i>&nbsp;New Article
          </a>
        </li>
        <li class="nav-item">
          <a href={paths.settings} class={`nav-link ${active("/settings")}`}>
            <i class="ion-gear-a"></i>&nbsp;Settings
          </a>
        </li>
        <li class="nav-item">
          <a href={paths.profile($currentUsername)} class={`nav-link ${active("/profile")}`}>
            {#if $currentUser?.image}
              <img src={$currentUser.image} class="user-pic" alt={$currentUsername} />
            {/if}
            {$currentUsername}
          </a>
        </li>
      {:else}
        <li class="nav-item">
          <a href={paths.login} class={`nav-link ${active("/login")}`}>Sign in</a>
        </li>
        <li class="nav-item">
          <a href={paths.register} class={`nav-link ${active("/register")}`}>Sign up</a>
        </li>
      {/if}
    </ul>
  </div>
</nav>

{@render children()}

<footer>
  <div class="container">
    <a href={paths.home} class="logo-font">conduit</a>
    <span class="attribution">
      RealWorld example driving the
      <a href="https://github.com/thomasfosterau/legation">legation</a> engine.
    </span>
  </div>
</footer>
