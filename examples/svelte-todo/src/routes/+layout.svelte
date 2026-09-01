<script lang="ts">
  /**
   * Root layout
   *
   * Wires the engine runtime into context for the whole route tree (the Svelte
   * bindings' `query` stores and `getMutate` read it from there) and hands the
   * demo controls down as ordinary layout data.
   */
  import { Runtime } from "@legation/svelte";
  import { setDemo } from "$lib/demo";
  import "../app.css";

  const { data, children } = $props();

  // The world is a stable singleton the root `load` builds once, so reading it
  // at init — rather than through a closure — is exactly what's wanted here.
  // svelte-ignore state_referenced_locally
  Runtime.setEngineRuntime(data.runtime);
  // svelte-ignore state_referenced_locally
  setDemo(data.controls);
</script>

{@render children()}
