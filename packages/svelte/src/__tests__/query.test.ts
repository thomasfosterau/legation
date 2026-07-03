/**
 * Live query stores against a real engine (memory backend, loopback
 * transport) in mounted Svelte components: `query` re-emits on mutation,
 * `aggregate`/`aggregateGrouped` track counts, and `namedQuery` renders the
 * named query's client-local subset.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import { Subset } from "@legation/effect";
import QueryHarness from "./fixtures/QueryHarness.svelte";
import NamedQueryHarness from "./fixtures/NamedQueryHarness.svelte";
import { makeRuntime, run, until } from "./world.js";

const allTodos = Subset.make({ collection: "todos" });
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("query stores", () => {
  it("emits live rows and aggregates, updating on mutation", async () => {
    const runtime = makeRuntime();
    const app = mount(QueryHarness, {
      target: document.body,
      props: { runtime, subset: allTodos, groupBy: "authorId" },
    });

    await until(() => text().includes("count:0"));
    expect(text()).not.toContain("seed");

    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seed", authorId: "u1" })
    );
    await until(() => text().includes("seed"));
    await until(() => text().includes("count:1"));
    await until(() => text().includes('"u1":1'));

    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "2", title: "second", authorId: "u1" })
    );
    await until(() => text().includes("count:2"));
    await until(() => text().includes('"u1":2'));

    unmount(app);
    await runtime.dispose();
  });

  it("namedQuery renders only the named query's client-local subset", async () => {
    const runtime = makeRuntime();
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "1", title: "match" }));
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "other" }));

    const app = mount(NamedQueryHarness, {
      target: document.body,
      props: { runtime, name: "todos/byTitle", args: { title: "match" } },
    });

    await until(() => text().includes("match"));
    expect(text()).not.toContain("other");

    unmount(app);
    await runtime.dispose();
  });
});
