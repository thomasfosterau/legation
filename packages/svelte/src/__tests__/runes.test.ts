/**
 * Rune-based hooks (`@legation/svelte/runes`) in mounted Svelte 5 components:
 * `useQuery` re-subscribes when its thunk's reactive inputs change (keeping
 * the previous value as a waiting result), `useAggregate` tracks counts, and
 * `useRelated` resolves declared relationships live — including the
 * `subscribe: true` variant that syncs its own subsets.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import { Subset } from "@legation/effect";
import RunesQueryHarness from "./fixtures/RunesQueryHarness.svelte";
import RunesRelatedHarness from "./fixtures/RunesRelatedHarness.svelte";
import { buttonByLabel, collections, makeRuntime, run, until } from "./world.js";

const allTodos = Subset.make({ collection: "todos" });
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("rune hooks", () => {
  it("useQuery re-subscribes on reactive input change; useAggregate stays live", async () => {
    const runtime = makeRuntime();
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "1", title: "match" }));
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "other" }));

    const app = mount(RunesQueryHarness, { target: document.body, props: { runtime } });

    await until(() => text().includes("row:match"));
    expect(text()).not.toContain("row:other");
    await until(() => text().includes("count:2"));
    await until(() => text().includes("state:Success") && !text().includes(":waiting"));

    // Flip the reactive input: the hook re-subscribes to the new subset.
    buttonByLabel("switch").click();
    await until(() => text().includes("row:other"));
    expect(text()).not.toContain("row:match");

    // A mutation matching the new subset re-emits.
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "3", title: "other" }));
    await until(() => text().includes("count:3"));

    unmount(app);
    await runtime.dispose();
  });

  it("initial seeds a synchronous Success before the first emission", async () => {
    const runtime = makeRuntime();
    const app = mount(RunesQueryHarness, {
      target: document.body,
      props: {
        runtime,
        initial: [{ id: "s1", value: { id: "s1", title: "match" } }],
      },
    });

    // Rendered synchronously from the seed at mount, before $effect ever
    // runs — no Initial flash. The seed is a NON-waiting Success ("we have
    // data": no spinner over server-rendered content); the live stream's
    // first emission replaces it. This is also exactly what SSR renders,
    // where $effect never runs at all.
    expect(text()).toContain("row:match");
    expect(text()).toContain("state:Success");
    expect(text()).not.toContain(":waiting");

    // The live subscription then takes over (the engine has no such row).
    await until(() => !text().includes("row:match"));
    expect(text()).toContain("state:Success");
    expect(text()).not.toContain(":waiting");

    unmount(app);
    await runtime.dispose();
  });

  it("useRelated joins declared relationships and re-emits on foreign writes", async () => {
    const runtime = makeRuntime();
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Ada" }));
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seed", authorId: "u1" })
    );

    const app = mount(RunesRelatedHarness, {
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
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Grace" }));
    await until(() => text().includes("seed:Grace"));
    expect(text()).not.toContain("seed:Ada");

    unmount(app);
    await runtime.dispose();
  });

  it("useRelated with subscribe: true syncs its own subsets from the backend", async () => {
    const runtime = makeRuntime();
    // Rows exist server-side only: the hook must subscribe + pull itself.
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Ada" }));
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seed", authorId: "u1" })
    );
    await run(runtime, (engine) => engine.push);

    const app = mount(RunesRelatedHarness, {
      target: document.body,
      props: {
        runtime,
        registry: collections,
        collection: "todos",
        subset: allTodos,
        names: ["author"],
        subscribe: true,
      },
    });

    await until(() => text().includes("seed:Ada"));
    expect(text()).toContain("seed:Ada");

    unmount(app);
    await runtime.dispose();
  });
});
