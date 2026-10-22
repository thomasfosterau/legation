/**
 * Mutate hooks from mounted components: `useMutation` applies optimistically,
 * `useMutationWithAck` resolves with the backend outcome after a push —
 * applied for an accepted mutation, rejected (with the optimistic row dropped
 * on the next rebase) for a permanently rejected one.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import type { ClientEngine } from "@thomasfosterau/legation-effect/internal";
import MutateHarness from "./fixtures/MutateHarness.svelte";
import QueryHarness from "./fixtures/QueryHarness.svelte";
import { buttonByLabel, makeClientRuntime, run, until } from "./world.js";

const allTodos = { collection: "todos" };
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mutate hooks", () => {
  it("useMutation applies the optimistic write; the ack settles after a push", async () => {
    const runtime = makeClientRuntime();
    let outcome: ClientEngine.MutationOutcome | undefined;
    const list = mount(QueryHarness, {
      target: document.body,
      props: { runtime, read: allTodos, groupBy: "authorId" },
    });
    const buttons = mount(MutateHarness, {
      target: document.body,
      props: { runtime, onOutcome: (value: ClientEngine.MutationOutcome) => (outcome = value) },
    });

    buttonByLabel("add").click();
    await until(() => text().includes("added"));

    buttonByLabel("ack").click();
    // The optimistic write lands (and the ack is registered) before the push.
    await until(() => text().includes("awaited"));
    expect(outcome).toBeUndefined();

    await run(runtime, (engine) => engine.push);
    await until(() => outcome !== undefined);
    expect(outcome).toEqual({ _tag: "applied" });

    unmount(buttons);
    unmount(list);
    await runtime.dispose();
  });

  it("a permanent rejection settles the ack and drops the optimistic row on rebase", async () => {
    const runtime = makeClientRuntime();
    let outcome: ClientEngine.MutationOutcome | undefined;
    const list = mount(QueryHarness, {
      target: document.body,
      props: { runtime, read: allTodos, groupBy: "authorId" },
    });
    const buttons = mount(MutateHarness, {
      target: document.body,
      props: { runtime, onOutcome: (value: ClientEngine.MutationOutcome) => (outcome = value) },
    });

    buttonByLabel("reject").click();
    await until(() => text().includes("doomed"));

    await run(runtime, (engine) => engine.push);
    await until(() => outcome !== undefined);
    expect(outcome).toEqual({ _tag: "rejected", reason: "not allowed" });

    // The rebase that observes the bumped mutation id drops the overlay row.
    await run(runtime, (engine) => engine.pull);
    await until(() => !text().includes("doomed"));

    unmount(buttons);
    unmount(list);
    await runtime.dispose();
  });
});
