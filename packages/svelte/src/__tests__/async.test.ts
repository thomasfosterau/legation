/**
 * Async Svelte (`experimental.async`) over the binding's awaitable surface:
 * `Live.promise` suspends a `<svelte:boundary>`'s `pending` snippet until
 * the first data arrives, then stays live — each emission replaces it with
 * an already-resolved promise, re-running awaiting expressions while Svelte
 * keeps the previous UI on screen (stale-while-revalidate, no pending flash
 * after first load).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import { Effect } from "effect";
import { Subset } from "@legation/effect";
import AsyncQueryHarness from "./fixtures/AsyncQueryHarness.svelte";
import { makeRuntime, run, until } from "./world.js";

const allTodos = Subset.make({ collection: "todos" });
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Async Svelte over Live.promise", () => {
  it("suspends the boundary until first data, then updates without re-pending", async () => {
    const runtime = makeRuntime();
    await run(runtime, (engine) => engine.subscribe(allTodos));

    const harness = mount(AsyncQueryHarness, {
      target: document.body,
      props: { runtime, subset: allTodos },
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
    const runtime = makeRuntime();
    await run(runtime, (engine) =>
      Effect.andThen(
        engine.subscribe(allTodos),
        engine.mutate("todo/set", { id: "1", title: "seeded", authorId: "u1" })
      )
    );
    const seeded = await run(runtime, (engine) => engine.query(allTodos));

    const harness = mount(AsyncQueryHarness, {
      target: document.body,
      props: { runtime, subset: allTodos, initial: seeded },
    });

    // The seed resolves the promise synchronously — no pending snippet even
    // before the live stream's first emission.
    await until(() => text().includes("seeded"));
    expect(text()).not.toContain("pending…");

    unmount(harness);
    await runtime.dispose();
  });
});
