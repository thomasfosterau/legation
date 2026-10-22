/**
 * Undo
 *
 * An optional, additive undo/redo module layered over anything that can
 * `mutate(name, args)` — no engine surgery (issue #46). It follows the
 * *paired-intents* design (the `@rocicorp/undo` shape): the caller supplies
 * both directions of a change at run time, and undo/redo replay through the
 * supplied handle's ordinary `mutate` pipeline — a `ClientEngine`, a
 * `Client`, or a test double all satisfy {@link MutateHandle} structurally
 * (issue #223). Because they are just mutations, undo and redo are
 * optimistic, journaled, rebased, and offline-safe like any other write —
 * the module adds only the in-memory history.
 *
 * `ClientEngine.mutate` and `Client.mutate` do not share an error channel
 * (the engine fails with its mutator/store union, the Client with its
 * narrower view error), so both {@link MutateHandle} and {@link UndoManager}
 * are generic in that error type: whatever the supplied handle's `mutate`
 * fails with is what `run`/`undo`/`redo` fail with, unchanged.
 *
 * History is a per-client, in-memory pair of stacks (one manager per handle).
 * It does not survive a reload; the journal (which does) still carries any
 * pending undo/redo mutations to the backend.
 *
 * ## Paired intents
 *
 * Each {@link UndoEntry} names the mutator + args to run now (`execute`) and the
 * mutator + args that reverse it (`undo`). The caller captures whatever the
 * reversal needs at run time — crucially, the *pre-delete value*: read the row
 * from the local view, then `run({ execute: delete, undo: set(capturedValue) })`
 * so an undo re-creates the row exactly.
 *
 * ## Grouping
 *
 * {@link UndoManager.group} coalesces every `run` made while its effect runs
 * into ONE composite step: a single `undo` replays each member's `undo` in
 * reverse order, a single `redo` replays each member's `execute` in order.
 */

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** A mutator invocation: the name and (decoded) args handed to `mutate`. */
export interface MutationIntent {
  readonly mutator: string;
  readonly args: unknown;
}

/**
 * A reversible action as a pair of intents: `execute` applies it, `undo`
 * reverses it. Both replay through `ClientEngine.mutate`, so both are
 * optimistic, journaled, and rebased.
 */
export interface UndoEntry {
  readonly execute: MutationIntent;
  readonly undo: MutationIntent;
}

/** One history step: a single `run`, or a whole {@link UndoManager.group}. */
type Step = ReadonlyArray<UndoEntry>;

/** The in-memory history: the undo stack and the redo stack (top = last). */
interface History {
  readonly undo: ReadonlyArray<Step>;
  readonly redo: ReadonlyArray<Step>;
}

const EMPTY_HISTORY: History = { undo: [], redo: [] };

/**
 * The structural shape {@link make} needs: anything that can run a named
 * mutation. A `ClientEngine` and a `Client` both satisfy this — with
 * different error channels, hence the type parameter (issue #223).
 */
export interface MutateHandle<E> {
  readonly mutate: (mutator: string, args: unknown) => Effect.Effect<void, E>;
}

/**
 * A per-client undo/redo manager over a {@link MutateHandle}. Every operation
 * runs through the handle's `mutate` pipeline, so a failed mutation surfaces
 * as `E` — the handle's own error type; the manager itself only owns the
 * in-memory history and the grouping flag.
 */
export interface UndoManager<E> {
  /**
   * Run an entry's `execute` through `mutate`, push it onto the undo stack, and
   * clear the redo stack (a new action invalidates any redo). Inside a
   * {@link group}, the entry is instead accumulated into the group's step.
   */
  readonly run: (entry: UndoEntry) => Effect.Effect<void, E>;
  /**
   * Pop the top undo step, replay its members' `undo` intents (in reverse order
   * for a group), and push it onto the redo stack. A no-op when the undo stack
   * is empty.
   */
  readonly undo: Effect.Effect<void, E>;
  /**
   * Pop the top redo step, replay its members' `execute` intents (in order for a
   * group), and push it back onto the undo stack. A no-op when the redo stack is
   * empty.
   */
  readonly redo: Effect.Effect<void, E>;
  /** Whether an undo is currently possible. */
  readonly canUndo: Effect.Effect<boolean>;
  /** Whether a redo is currently possible. */
  readonly canRedo: Effect.Effect<boolean>;
  /** Observable {@link canUndo} for bindings (emits now, then on every change). */
  readonly canUndoChanges: Stream.Stream<boolean>;
  /** Observable {@link canRedo} for bindings (emits now, then on every change). */
  readonly canRedoChanges: Stream.Stream<boolean>;
  /**
   * Coalesce every `run` made while `effect` runs into a single undo step. The
   * effect's own result, errors, and requirements pass through unchanged.
   * Nested groups fold into the outermost one.
   */
  readonly group: <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>;
}

/**
 * Build an {@link UndoManager} over any {@link MutateHandle} — a
 * `ClientEngine`, a `Client`, or a test double. History is in-memory, so
 * nothing needs a scope; the manager lives as long as the reference is held.
 * The manager's error type is inferred from the handle's `mutate`, so a
 * `ClientEngine` yields the same mutator/store union it always has, and a
 * `Client` yields its narrower view error.
 */
export const make = <E>(handle: MutateHandle<E>): Effect.Effect<UndoManager<E>> =>
  Effect.gen(function* () {
    const history = yield* SubscriptionRef.make<History>(EMPTY_HISTORY);
    // The current group's accumulator, or `undefined` when not grouping.
    const groupBuffer = yield* Ref.make<ReadonlyArray<UndoEntry> | undefined>(undefined);

    const runIntent = (intent: MutationIntent): Effect.Effect<void, E> =>
      handle.mutate(intent.mutator, intent.args);

    // Push a completed step; a new action always clears the redo stack.
    const pushStep = (step: Step): Effect.Effect<void> =>
      SubscriptionRef.update(history, (h) => ({ undo: [...h.undo, step], redo: [] }));

    // Record an executed entry: accumulate into the open group, else push it as
    // its own one-member step.
    const record = (entry: UndoEntry): Effect.Effect<void> =>
      Ref.get(groupBuffer).pipe(
        Effect.flatMap((buffer) =>
          buffer === undefined ? pushStep([entry]) : Ref.set(groupBuffer, [...buffer, entry])
        )
      );

    const run: UndoManager<E>["run"] = (entry) =>
      runIntent(entry.execute).pipe(Effect.andThen(record(entry)));

    // Pop the top of one stack without touching the other; `undefined` when empty.
    const take = (from: "undo" | "redo"): Effect.Effect<Step | undefined> =>
      SubscriptionRef.modify(history, (h) => {
        const stack = h[from];
        if (stack.length === 0) return [undefined, h] as const;
        const step = stack[stack.length - 1]!;
        return [step, { ...h, [from]: stack.slice(0, -1) }] as const;
      });

    const pushOnto = (onto: "undo" | "redo", step: Step): Effect.Effect<void> =>
      SubscriptionRef.update(history, (h) => ({ ...h, [onto]: [...h[onto], step] }));

    // Replay a step's members: undo runs the `undo` intents in reverse order,
    // redo runs the `execute` intents in order — the mirror of one another.
    const replay = (step: Step, direction: "undo" | "redo"): Effect.Effect<void, E> =>
      Effect.gen(function* () {
        const ordered = direction === "undo" ? [...step].reverse() : step;
        for (const entry of ordered) {
          yield* runIntent(direction === "undo" ? entry.undo : entry.execute);
        }
      });

    // Pop `from`, replay it, then push it `onto` the opposite stack. Empty → no-op.
    const step = (from: "undo" | "redo", onto: "undo" | "redo"): Effect.Effect<void, E> =>
      take(from).pipe(
        Effect.flatMap((popped) =>
          popped === undefined
            ? Effect.void
            : replay(popped, from).pipe(Effect.andThen(pushOnto(onto, popped)))
        )
      );

    const canUndo = SubscriptionRef.get(history).pipe(Effect.map((h) => h.undo.length > 0));
    const canRedo = SubscriptionRef.get(history).pipe(Effect.map((h) => h.redo.length > 0));

    const observe = (project: (h: History) => boolean): Stream.Stream<boolean> =>
      SubscriptionRef.changes(history).pipe(Stream.map(project), Stream.changes);

    // Flush the open group as one step (nothing to push for an empty group).
    const flushGroup: Effect.Effect<void> = Ref.get(groupBuffer).pipe(
      Effect.flatMap((buffer) =>
        buffer !== undefined && buffer.length > 0 ? pushStep(buffer) : Effect.void
      )
    );

    const group: UndoManager<E>["group"] = (effect) =>
      Ref.get(groupBuffer).pipe(
        Effect.flatMap((existing) =>
          // Already grouping → join the outer group; its members keep accumulating.
          existing !== undefined
            ? effect
            : Ref.set(groupBuffer, []).pipe(
                Effect.andThen(effect),
                Effect.tap(() => flushGroup),
                Effect.ensuring(Ref.set(groupBuffer, undefined))
              )
        )
      );

    return {
      run,
      undo: step("undo", "redo"),
      redo: step("redo", "undo"),
      canUndo,
      canRedo,
      canUndoChanges: observe((h) => h.undo.length > 0),
      canRedoChanges: observe((h) => h.redo.length > 0),
      group,
    } satisfies UndoManager<E>;
  });
