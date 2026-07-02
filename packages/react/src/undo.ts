/**
 * Undo hook
 *
 * `useUndo(manager)` binds a core {@link Undo.UndoManager} to React: `canUndo` /
 * `canRedo` track the manager's observable streams through `useSyncExternalStore`
 * (the same primitive `useQuery` uses), and `undo` / `redo` are event handlers.
 *
 * The manager's effects and streams close over the engine (no `R`), so they run
 * on the default runtime with `Effect.runFork` — no provider or registry needed
 * beyond the manager itself. Build one per client with `Undo.make(engine)`.
 */
import * as React from "react";
import { Effect, Fiber, Stream } from "effect";
import type { Undo } from "@legation/effect";

/** What {@link useUndo} returns: two commands and their live availability. */
export interface UndoControls {
  /** Run the manager's `undo` (a no-op when nothing is undoable). */
  readonly undo: () => void;
  /** Run the manager's `redo` (a no-op when nothing is redoable). */
  readonly redo: () => void;
  /** Whether an undo is currently possible (live). */
  readonly canUndo: boolean;
  /** Whether a redo is currently possible (live). */
  readonly canRedo: boolean;
}

/** Subscribe a component to a boolean stream, re-rendering on every change. */
const useStreamBoolean = (changes: Stream.Stream<boolean>): boolean => {
  // The latest value, seeded false (fresh stacks are empty); the subscription
  // pushes the manager's current value immediately, then every change.
  const cache = React.useRef(false);
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const fiber = Effect.runFork(
        Stream.runForEach(changes, (value) =>
          Effect.sync(() => {
            cache.current = value;
            onChange();
          })
        )
      );
      return () => {
        Effect.runFork(Fiber.interrupt(fiber));
      };
    },
    [changes]
  );
  const snapshot = React.useCallback(() => cache.current, []);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

/** Bind an {@link Undo.UndoManager} to `{ undo, redo, canUndo, canRedo }`. */
export const useUndo = (manager: Undo.UndoManager): UndoControls => {
  const canUndo = useStreamBoolean(manager.canUndoChanges);
  const canRedo = useStreamBoolean(manager.canRedoChanges);
  const undo = React.useCallback(() => {
    Effect.runFork(manager.undo);
  }, [manager]);
  const redo = React.useCallback(() => {
    Effect.runFork(manager.redo);
  }, [manager]);
  return { undo, redo, canUndo, canRedo };
};
