/**
 * `useUndo`: `canUndo`/`canRedo` are runes over the manager's history change
 * streams, and `undo`/`redo` replay the paired intents through the engine.
 * The manager closes over the engine, so the hook needs no Client in context —
 * only a mounted component, for its `$effect`.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import * as Effect from "effect/Effect";
import { Subset, Undo } from "@thomasfosterau/legation-effect/internal";
import UndoHarness from "./fixtures/UndoHarness.svelte";
import { buttonByLabel, makeClientRuntime, run, until } from "./world.js";

const allTodos = Subset.make({ collection: "todos" });
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useUndo", () => {
  it("tracks history availability and replays intents", async () => {
    const runtime = makeClientRuntime();
    const manager = await run(runtime, (engine) => Undo.make(engine));
    const app = mount(UndoHarness, { target: document.body, props: { manager } });

    // The runes seed false and re-emit from the manager's change streams.
    await until(() => text().includes("canUndo:false") && text().includes("canRedo:false"));

    await Effect.runPromise(
      manager.run({
        execute: { mutator: "todo/set", args: { id: "1", title: "after" } },
        undo: { mutator: "todo/set", args: { id: "1", title: "before" } },
      })
    );
    await until(() => text().includes("canUndo:true"));

    const titles = async (): Promise<ReadonlyArray<string>> =>
      (await run(runtime, (engine) => engine.query(allTodos))).map(
        (row) => (row.value as { title: string }).title
      );
    expect(await titles()).toEqual(["after"]);

    buttonByLabel("undo").click();
    await until(() => text().includes("canRedo:true") && text().includes("canUndo:false"));
    expect(await titles()).toEqual(["before"]);

    buttonByLabel("redo").click();
    await until(() => text().includes("canUndo:true") && text().includes("canRedo:false"));
    expect(await titles()).toEqual(["after"]);

    await unmount(app);
    await runtime.dispose();
  });
});
