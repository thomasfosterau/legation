<script lang="ts">
  /**
   * App shell — header nav, sync status banner, and the footer.
   *
   * The root wires the Client runtime into context (ADR-0022) and builds the
   * one session, sharing it the same way. The header reflects the live session;
   * the banner reflects the live transport status and lets you toggle offline
   * to watch writes queue in the durable journal and flush on reconnect.
   *
   * Everything between the header and the footer is SvelteKit's own router:
   * `{@render children()}` renders whichever `+page.svelte` under `src/routes`
   * matches the URL.
   */
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { Effect, Fiber, Stream } from "effect";
  import { AsyncResult } from "effect/reactivity";
  import { setClientRuntime } from "@thomasfosterau/legation-svelte";
  import { useMutation, useQuery } from "@thomasfosterau/legation-svelte";
  import type { Transport } from "@thomasfosterau/legation-effect";
  import { allUsers, type User } from "#lib/domain.js";
  import { values } from "#lib/joins.js";
  import { createSession, setSession } from "#lib/session.svelte.js";

  const { data, children } = $props();
  // The world is a stable singleton the root `load` builds once, so reading it
  // at init — rather than through a closure — is exactly what's wanted here.
  // svelte-ignore state_referenced_locally
  const world = data.world;

  setClientRuntime(world.runtime);

  // The session needs the live users read (to verify a login and to resolve the
  // signed-in user's row) and the mutate helper (to register / update).
  const userRows = useQuery(() => allUsers);
  const users = $derived(values<User>(AsyncResult.getOrElse(userRows.current, () => [])));
  const session = createSession(() => users, useMutation(), world);
  setSession(session);

  // Connection status as a rune: the transport's own stream, drained into
  // `$state` for the banner.
  let connection = $state<Transport.ConnectionStatus>("connecting");
  $effect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(world.connection, (next) => Effect.sync(() => (connection = next)))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

  const offline = $derived(connection === "disconnected");
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
      legation · in-page Server + MemoryBackend ·
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
    <a href={resolve("/")} class="navbar-brand">conduit</a>
    <ul class="nav navbar-nav pull-xs-right">
      <li class="nav-item">
        <a href={resolve("/")} class={`nav-link ${active("/")}`}>Home</a>
      </li>
      {#if session.username}
        <li class="nav-item">
          <a href={resolve("/editor/[[slug]]", {})} class={`nav-link ${active("/editor")}`}>
            <i class="ion-compose"></i>&nbsp;New Article
          </a>
        </li>
        <li class="nav-item">
          <a href={resolve("/settings")} class={`nav-link ${active("/settings")}`}>
            <i class="ion-gear-a"></i>&nbsp;Settings
          </a>
        </li>
        <li class="nav-item">
          <a href={resolve("/profile/[username]/[[tab=favorites]]", { username: session.username })} class={`nav-link ${active("/profile")}`}>
            {#if session.user?.image}
              <img src={session.user.image} class="user-pic" alt={session.username} />
            {/if}
            {session.username}
          </a>
        </li>
      {:else}
        <li class="nav-item">
          <a href={resolve("/login")} class={`nav-link ${active("/login")}`}>Sign in</a>
        </li>
        <li class="nav-item">
          <a href={resolve("/register")} class={`nav-link ${active("/register")}`}>Sign up</a>
        </li>
      {/if}
    </ul>
  </div>
</nav>

{@render children()}

<footer>
  <div class="container">
    <a href={resolve("/")} class="logo-font">conduit</a>
    <span class="attribution">
      RealWorld example driving the
      <a href="https://github.com/thomasfosterau/legation">legation</a> engine.
    </span>
  </div>
</footer>
