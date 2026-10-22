/**
 * `useMutationState` (#116): the rune-based mutation-state list, mounted in a
 * real Svelte 5 component. Reflects a plain `mutate`-journaled mutation
 * (not just `mutateWithAck`) through pending → acknowledged, both the whole
 * map and a reactive per-mutator scope.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import RunesMutationStateHarness from "./fixtures/RunesMutationStateHarness.svelte";
import { buttonByLabel, makeClientRuntime, run, until } from "./world.js";

const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useMutationState (#116)", () => {
  it("reflects a journaled mutation through pending → acknowledged, whole map and scoped", async () => {
    const runtime = makeClientRuntime();
    const app = mount(RunesMutationStateHarness, { target: document.body, props: { runtime } });

    expect(text()).toContain("scoped-count:0");

    buttonByLabel("mutate").click();
    await until(() => text().includes("all:1:pending"));

    // The reactive scope thunk re-subscribes the filtered rune on change.
    buttonByLabel("scope").click();
    await until(() => text().includes("scoped-count:1"));

    await run(runtime, (engine) => engine.push);
    await until(() => text().includes("all:1:acknowledged"));
    expect(text()).not.toContain("all:1:pending");

    unmount(app);
    await runtime.dispose();
  });
});
