/**
 * Async Svelte (`experimental.async`) over the binding's awaitable surface:
 * `Live.promise` suspends a `<svelte:boundary>`'s `pending` snippet until
 * the first data arrives, then stays live — each emission replaces it with
 * an already-resolved promise, re-running awaiting expressions while Svelte
 * keeps the previous UI on screen (stale-while-revalidate, no pending flash
 * after first load).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import type { Query } from "@thomasfosterau/legation-effect";
import AsyncQueryHarness from "./fixtures/AsyncQueryHarness.svelte";
import { makeClientRuntime, run, until } from "./world.js";

const allTodos: Query.Read = { collection: "todos" };
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Async Svelte over Live.promise", () => {
  it("suspends the boundary until first data, then updates without re-pending", async () => {
    const runtime = makeClientRuntime();

    const harness = mount(AsyncQueryHarness, {
      target: document.body,
      props: { runtime, read: allTodos },
    });

    // Before the first emission the boundary shows its pending snippet.
    await until(() => text().includes("pending…") || text().includes("loaded:"));

    // First emission resolves the promise; the boundary settles.
    await until(() => text().includes("loaded:0"));
    expect(text()).not.toContain("pending…");

    // A write re-resolves the awaited expression — no pending flash.
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "awaited", authorId: "u1" })
    );
    await until(() => text().includes("awaited") && text().includes("loaded:1"));
    expect(text()).not.toContain("pending…");

    unmount(harness);
    await runtime.dispose();
  });

  it("keeps SSR-style initial seeds synchronous while the live stream takes over", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seeded", authorId: "u1" })
    );

    const harness = mount(AsyncQueryHarness, {
      target: document.body,
      props: {
        runtime,
        read: allTodos,
        initial: [{ id: "1", value: { id: "1", title: "seeded", authorId: "u1" }, related: {} }],
      },
    });

    // The seed resolves the promise synchronously — no pending snippet even
    // before the live stream's first emission.
    await until(() => text().includes("seeded"));
    expect(text()).not.toContain("pending…");

    unmount(harness);
    await runtime.dispose();
  });
});
