/**
 * Ambient module declaration so `tsc` (tsconfig.check.json) can type the
 * `.svelte` fixture imports in these tests; `svelte-check` is not part of the
 * package pipeline. Props stay untyped at this boundary — the fixtures type
 * them internally.
 */
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}
