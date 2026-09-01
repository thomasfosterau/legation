/**
 * Rune-based hooks (`@legation/svelte/Runes`) in mounted Svelte 5
 * components, speaking Query over the Client (ADR-0022): `useQuery`
 * re-subscribes when its read thunk's reactive inputs change (keeping the
 * previous value as a waiting result), `useAggregate` tracks counts, and
 * `include` resolves edges live — the hook subscribes its own windows, so
 * server-side rows arrive without any manual registration.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import RunesQueryHarness from "./fixtures/RunesQueryHarness.svelte";
import RunesRelatedHarness from "./fixtures/RunesRelatedHarness.svelte";
import { buttonByLabel, makeClientRuntime, run, until } from "./world.js";

const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("rune hooks", () => {
  it("useQuery re-subscribes on reactive input change; useAggregate stays live", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "1", title: "match" }));
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "other" }));

    const app = mount(RunesQueryHarness, { target: document.body, props: { runtime } });

    await until(() => text().includes("row:match"));
    expect(text()).not.toContain("row:other");
    await until(() => text().includes("count:2"));
    await until(() => text().includes("state:Success") && !text().includes(":waiting"));

    // Flip the reactive input: the hook re-subscribes to the new read.
    buttonByLabel("switch").click();
    await until(() => text().includes("row:other"));
    expect(text()).not.toContain("row:match");

    // A mutation matching the new read re-emits.
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "3", title: "other" }));
    await until(() => text().includes("count:3"));

    unmount(app);
    await runtime.dispose();
  });

  it("initial seeds a synchronous Success before the first emission", async () => {
    const runtime = makeClientRuntime();
    const app = mount(RunesQueryHarness, {
      target: document.body,
      props: {
        runtime,
        initial: [{ id: "s1", value: { id: "s1", title: "match" }, related: {} }],
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

  it("include joins edges and re-emits on foreign writes", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Ada" }));
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seed", authorId: "u1" })
    );

    const app = mount(RunesRelatedHarness, {
      target: document.body,
      props: { runtime, read: { collection: "todos", include: { author: true } } },
    });

    await until(() => text().includes("seed:Ada"));
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Grace" }));
    await until(() => text().includes("seed:Grace"));
    expect(text()).not.toContain("seed:Ada");

    // A base row with no linkage resolves to no related row.
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "orphan" }));
    await until(() => text().includes("orphan:nobody"));
    expect(text()).toContain("seed:Grace");

    unmount(app);
    await runtime.dispose();
  });

  it("observing subscribes: server-side rows arrive without manual registration", async () => {
    const runtime = makeClientRuntime();
    // Rows exist server-side only: the hook must subscribe + pull itself.
    await run(runtime, (engine) => engine.mutate("user/set", { id: "u1", name: "Ada" }));
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "1", title: "seed", authorId: "u1" })
    );
    await run(runtime, (engine) => engine.push);

    const app = mount(RunesRelatedHarness, {
      target: document.body,
      props: { runtime, read: { collection: "todos", include: { author: true } } },
    });

    await until(() => text().includes("seed:Ada"));
    expect(text()).toContain("seed:Ada");

    unmount(app);
    await runtime.dispose();
  });
});
