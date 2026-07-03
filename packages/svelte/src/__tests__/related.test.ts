/**
 * The `related` store: a live join over a subset's declared relationships —
 * base rows carry their resolved related rows, and a write to a referenced
 * foreign row re-emits the join without touching the base.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import { Subset } from "@legation/effect";
import RelatedHarness from "./fixtures/RelatedHarness.svelte";
import { collections, makeRuntime, run, until } from "./world.js";

const allTodos = Subset.make({ collection: "todos" });
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("related store", () => {
  it("joins declared relationships and re-emits on foreign row changes", async () => {
    const runtime = makeRuntime();
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Ada" }));
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seed", authorId: "u1" })
    );

    const app = mount(RelatedHarness, {
      target: document.body,
      props: {
        runtime,
        registry: collections,
        collection: "todos",
        subset: allTodos,
        names: ["author"],
      },
    });

    await until(() => text().includes("seed:Ada"));

    // A write to the referenced user re-emits the join with the new value.
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Grace" }));
    await until(() => text().includes("seed:Grace"));

    // A base row without linkage resolves to no related row.
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "orphan" }));
    await until(() => text().includes("orphan:nobody"));
    expect(text()).toContain("seed:Grace");

    unmount(app);
    await runtime.dispose();
  });
});
