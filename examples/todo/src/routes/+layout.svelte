<script lang="ts">
  /**
   * Root layout
   *
   * Wires the Client runtime into context for the whole route tree (the rune
   * hooks read it from there, ADR-0022) and hands the demo controls down the
   * same way.
   */
  import { Runtime } from "@legation/svelte";
  import { setDemo } from "$lib/demo.svelte";
  import "../app.css";

  const { data, children } = $props();

  // The world is a stable singleton the root `load` builds once, so reading it
  // at init — rather than through a closure — is exactly what's wanted here.
  // svelte-ignore state_referenced_locally
  const world = data.world;

  Runtime.setClientRuntime(world.runtime);
  setDemo(world.demo);
</script>

{@render children()}
