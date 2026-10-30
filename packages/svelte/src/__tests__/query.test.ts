/**
 * Live reads against a real engine (memory backend, loopback transport) in
 * mounted Svelte components: `useQuery` re-emits on mutation,
 * `useAggregate`/`useAggregateGrouped` track counts, and `useNamedQuery`
 * renders the named query's client-local subset.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import QueryHarness from "./fixtures/QueryHarness.svelte";
import NamedQueryHarness from "./fixtures/NamedQueryHarness.svelte";
import { makeClientRuntime, run, until } from "./world.js";

const allTodos = { collection: "todos" };
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("live read hooks", () => {
  it("emits live rows and aggregates, updating on mutation", async () => {
    const runtime = makeClientRuntime();
    const app = mount(QueryHarness, {
      target: document.body,
      props: { runtime, read: allTodos, groupBy: "authorId" },
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

    await unmount(app);
    await runtime.dispose();
  });

  it("useNamedQuery renders only the named query's client-local subset", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "1", title: "match" }));
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "other" }));

    const app = mount(NamedQueryHarness, {
      target: document.body,
      props: { runtime, name: "todos/byTitle", args: { title: "match" } },
    });

    await until(() => text().includes("match"));
    expect(text()).not.toContain("other");

    await unmount(app);
    await runtime.dispose();
  });
});
