/**
 * Undo controls
 *
 * `undoControls(manager)` binds a core {@link Undo.UndoManager} to Svelte:
 * `canUndo` / `canRedo` are live `Readable` stores over the manager's observable
 * streams (read them with `$canUndo`), and `undo` / `redo` are promise-returning
 * handlers for `on:click`.
 *
 * The manager's effects and streams close over the engine (no `R`), so they run
 * on the default runtime with `Effect.runFork` — no `setEngineRuntime` needed
 * for the controls themselves. Build one manager per client with
 * `Undo.make(engine)`.
 */
import { readable, type Readable } from "svelte/store";
import { Effect, Fiber, Stream } from "effect";
import type { Undo } from "@legation/effect";

/** What {@link undoControls} returns: live availability + two commands. */
export interface UndoControls {
  /** Whether an undo is currently possible (live store). */
  readonly canUndo: Readable<boolean>;
  /** Whether a redo is currently possible (live store). */
  readonly canRedo: Readable<boolean>;
  /** Run the manager's `undo` (a no-op when nothing is undoable). */
  readonly undo: () => Promise<void>;
  /** Run the manager's `redo` (a no-op when nothing is redoable). */
  readonly redo: () => Promise<void>;
}

/** A `Readable` over a boolean stream, seeded false and updated on every change. */
const boolStore = (changes: Stream.Stream<boolean>): Readable<boolean> =>
  readable(false, (set) => {
    const fiber = Effect.runFork(
      Stream.runForEach(changes, (value) => Effect.sync(() => set(value)))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

/** Bind an {@link Undo.UndoManager} to Svelte stores + handlers. */
export const undoControls = (manager: Undo.UndoManager): UndoControls => ({
  canUndo: boolStore(manager.canUndoChanges),
  canRedo: boolStore(manager.canRedoChanges),
  undo: () => Effect.runPromise(Effect.ignore(manager.undo)),
  redo: () => Effect.runPromise(Effect.ignore(manager.redo)),
});
