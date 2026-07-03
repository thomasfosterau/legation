/**
 * Undo controls: `canUndo`/`canRedo` are live stores over the manager's
 * history, and `undo`/`redo` replay the paired intents through the engine —
 * no component context required (the manager closes over the engine).
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Subset, Undo } from "@legation/effect";
import { get } from "svelte/store";
import { undoControls } from "../Undo.js";
import { makeRuntime, run, until } from "./world.js";

const allTodos = Subset.make({ collection: "todos" });

describe("undo controls", () => {
  it("tracks history availability and replays intents", async () => {
    const runtime = makeRuntime();
    const manager = await run(runtime, (engine) => Undo.make(engine));
    const controls = undoControls(manager);

    // Stores seed false and re-emit from the manager's change streams.
    await until(() => get(controls.canUndo) === false && get(controls.canRedo) === false);

    await Effect.runPromise(
      manager.run({
        execute: { mutator: "todo/set", args: { id: "1", title: "after" } },
        undo: { mutator: "todo/set", args: { id: "1", title: "before" } },
      })
    );
    await until(() => get(controls.canUndo) === true);

    const titles = async (): Promise<ReadonlyArray<string>> =>
      (await run(runtime, (engine) => engine.query(allTodos))).map(
        (row) => (row.value as { title: string }).title
      );
    expect(await titles()).toEqual(["after"]);

    await controls.undo();
    await until(() => get(controls.canRedo) === true && get(controls.canUndo) === false);
    expect(await titles()).toEqual(["before"]);

    await controls.redo();
    await until(() => get(controls.canUndo) === true && get(controls.canRedo) === false);
    expect(await titles()).toEqual(["after"]);

    await runtime.dispose();
  });
});
