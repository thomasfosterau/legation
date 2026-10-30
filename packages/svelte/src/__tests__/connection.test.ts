/**
 * Connection-style paging (`useConnection`, ADR-0024): `loadMore` widens the
 * one root window a page at a time — rows accumulate, the previous ones stay
 * on screen, and the engine only ever syncs the current window. Instantiating
 * the hook per parent (scoping `where` to a parent id) pages each parent's
 * list independently.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import RunesConnectionHarness from "./fixtures/RunesConnectionHarness.svelte";
import { buttonByLabel, makeClientRuntime, run, until } from "./world.js";

const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useConnection", () => {
  it("grows the window a page at a time; hasMore tracks the tail; reset collapses", async () => {
    const runtime = makeClientRuntime();
    for (let i = 1; i <= 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- deterministic ordered seed
      await run(runtime, (engine) =>
        engine.mutate("todo/set", { id: `t${i}`, title: `todo-${i}` })
      );
    }

    const app = mount(RunesConnectionHarness, {
      target: document.body,
      props: { runtime, pageSize: 2 },
    });

    // First page: two of five rows, and more to come.
    await until(() => text().includes("row-count:2"));
    expect(text()).toContain("row-hasMore:true");
    expect(text()).toContain("row:todo-1");
    expect(text()).toContain("row:todo-2");
    expect(text()).not.toContain("row:todo-3");

    // #133: count `ViewRebuilt` engine events from here on — a widen that
    // reuses the maintained order (`retarget`) fires none; only a genuine
    // Rebuild (a pull racing a pending mutation, a Clear) would.
    let rebuilds = 0;
    await run(runtime, (engine) =>
      Effect.forkDetach(
        Stream.runForEach(engine.engineEvents, (event) =>
          Effect.sync(() => {
            if (event._tag === "ViewRebuilt") rebuilds++;
          })
        )
      ).pipe(Effect.asVoid)
    );

    // Widen: the window grows in place, keeping the first page's rows.
    buttonByLabel("row:more").click();
    await until(() => text().includes("row-count:4"));
    expect(text()).toContain("row:todo-1");
    expect(text()).toContain("row:todo-4");
    expect(text()).toContain("row-hasMore:true");
    expect(rebuilds).toBe(0); // the widen reused LiveView's maintained order

    // The tail: the fifth row lands and the window is no longer saturated.
    buttonByLabel("row:more").click();
    await until(() => text().includes("row-count:5"));
    expect(text()).toContain("row:todo-5");
    await until(() => text().includes("row-hasMore:false"));

    // Past the end is a no-op.
    buttonByLabel("row:more").click();
    await until(() => text().includes("row-count:5"));
    expect(text()).toContain("row-count:5");

    // Reset collapses back to the first page.
    buttonByLabel("row:reset").click();
    await until(() => text().includes("row-count:2"));
    expect(text()).toContain("row:todo-1");
    expect(text()).not.toContain("row:todo-5");

    await unmount(app);
    await runtime.dispose();
  });

  it("pages each parent independently (per-parent connections)", async () => {
    const runtime = makeClientRuntime();
    for (let i = 1; i <= 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- deterministic ordered seed
      await run(runtime, (engine) =>
        engine.mutate("todo/set", { id: `u1-${i}`, title: `a-${i}`, authorId: "u1" })
      );
      // eslint-disable-next-line no-await-in-loop -- deterministic ordered seed
      await run(runtime, (engine) =>
        engine.mutate("todo/set", { id: `u2-${i}`, title: `b-${i}`, authorId: "u2" })
      );
    }

    const a = mount(RunesConnectionHarness, {
      target: document.body,
      props: { runtime, authorId: "u1", pageSize: 2, label: "a" },
    });
    const b = mount(RunesConnectionHarness, {
      target: document.body,
      props: { runtime, authorId: "u2", pageSize: 2, label: "b" },
    });

    // Both start at their own first page — and never cross authors.
    await until(() => text().includes("a-count:2") && text().includes("b-count:2"));
    expect(text()).toContain("a:a-1");
    expect(text()).toContain("b:b-1");
    expect(text()).not.toContain("a:b-1");

    // Widening A leaves B untouched — independent windows.
    buttonByLabel("a:more").click();
    await until(() => text().includes("a-count:4"));
    expect(text()).toContain("b-count:2");

    // Widening B now leaves A where it was.
    buttonByLabel("b:more").click();
    await until(() => text().includes("b-count:4"));
    expect(text()).toContain("a-count:4");

    await unmount(a);
    await unmount(b);
    await runtime.dispose();
  });
});
