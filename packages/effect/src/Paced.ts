/**
 * Paced mutations (#117)
 *
 * Debounce/throttle/coalesce strategies for rapid mutation intents — a text
 * field autosaving per keystroke, a slider, a cart-quantity stepper — layered
 * over {@link ClientEngine} the same way {@link Undo} is: no engine surgery,
 * built entirely from `mutateWithAck` + `dropIfPending` + Effect's own timing
 * primitives (`Effect.sleep`, `Fiber.interrupt`). No pacer dependency, no
 * general-purpose pacer module — just the journal-compaction rule ADR-0008
 * already permits on the unpushed tail.
 *
 * ## Design: journal-then-compact
 *
 * Every call — debounce, throttle, or coalesce — always journals through the
 * ordinary `mutateWithAck` path immediately: full durability, the usual
 * optimistic overlay render, no separate preview mechanism. What pacing adds
 * is a *compaction* step run after journaling: for the mutation's `key` (a
 * caller-supplied string — e.g. a row id — distinguishing independent rapid
 * intents from each other), drop the previous still-pending entry for that
 * key via {@link ClientEngine.dropIfPending}, so a burst collapses to the
 * newest entry rather than piling one row per call into the journal.
 *
 * This was chosen over the alternative sketched in #117 (journal once,
 * replace an unpushed entry's args in place) because it needs no new
 * "mutate this pushed-adjacent entry in place" primitive — `dropIfPending`
 * is a narrow, easily-audited addition (drop specific still-pending ids, never
 * touching anything a push may have claimed) that composes with the journal
 * exactly as `acknowledge` already does, and because journal-then-compact
 * gives every strategy the *same* durability profile for the leading and
 * every eagerly-journaled call: nothing is ever held only in memory once it
 * has been accepted as "the current value" for a key.
 *
 * The one place memory-only buffering remains is intentional: `debounce` and
 * `throttle` do not journal *every* call. A call arriving while a burst is
 * already active only updates an in-memory `latestArgs` slot and (for
 * `debounce`) restarts the trailing timer; the store is touched at most twice
 * per debounce window (leading + trailing) or once per throttle window,
 * regardless of how many calls landed inside it — which is what keeps overlay
 * replays bounded for a 50-keystroke burst. **Durability tradeoff:** the
 * args sitting in that in-memory slot between flushes are not journaled, so a
 * crash inside a debounce/throttle window loses the freshest edit — the
 * journal still holds the last successfully flushed (leading-edge) args, not
 * nothing, but not the very latest keystroke either. This mirrors TanStack
 * DB's `createPacedMutations` debounce/throttle strategies exactly. `coalesce`
 * has no such window — every call journals immediately — so its tradeoff is
 * the opposite one: momentarily more journal entries (until the next call's
 * compaction catches up), never a lost edit.
 *
 * ## Compaction renumbers (#249)
 *
 * The backends reject a gap in a client's mutation ids (ADR-0008), so dropping
 * a superseded entry is not enough: `dropIfPending` also renumbers the
 * surviving unpushed entries, in order, so the journal stays contiguous and a
 * push can drain it. That means an id this module remembered for a key can
 * move — and not only when *its own* instance compacts: any other paced
 * mutation on the same engine shifts every unpushed entry behind the one it
 * drops. Acting on a stale id could drop an unrelated entry that has since
 * taken that number, so every instance's bookkeeping lives in one registry per
 * engine and each compaction's moves are applied to all of it (see
 * {@link Tracker}).
 *
 * ## Undo pairing
 *
 * A caller combining this with {@link Undo}: wrap the whole burst (every
 * `PacedMutation.call` your input handler makes) in `undo.group(...)`. Because
 * `Undo.group` coalesces every `run` made while its effect executes into one
 * step regardless of how many, a coalesced/debounced/throttled burst becomes
 * a single undo step too, matching what the user actually experiences as one
 * edit.
 */
import { Effect, Fiber, Semaphore } from "effect";
import type { Duration, Scope } from "effect";
import type { ClientEngine } from "./ClientEngine.js";
import type { MutatorError, StoreError } from "./Errors.js";

/** A paced mutation bound to one mutator: `call(key, args)` supersedes any of
 * this key's own prior calls per the strategy's rule. */
export interface PacedMutation {
  /**
   * Journal `args` for `key`. `key` scopes compaction — calls with different
   * keys (e.g. different row ids) never supersede one another, only
   * consecutive calls sharing a key do.
   */
  readonly call: (key: string, args: unknown) => Effect.Effect<void, MutatorError | StoreError>;
}

/**
 * One paced instance's memory of the last entry it journaled for each key.
 * `Map<key, mutationId>`; the ids are kept current by {@link compact}.
 */
type Tracker = Map<string, number>;

/**
 * Every live {@link Tracker} for one engine. Weakly held, so an instance that
 * is dropped (a `coalesce` has no scope to release it from) does not pin its
 * map for the engine's lifetime.
 */
const trackersByEngine = new WeakMap<object, Set<WeakRef<Tracker>>>();

/** Trackers already registered, so each is added once. */
const registered = new WeakSet<Tracker>();

/** Register `tracker` so compactions by any instance on `engine` keep it current. */
const track = (engine: ClientEngine, tracker: Tracker): void => {
  if (registered.has(tracker)) return;
  registered.add(tracker);
  let all = trackersByEngine.get(engine);
  if (all === undefined) {
    all = new Set();
    trackersByEngine.set(engine, all);
  }
  all.add(new WeakRef(tracker));
};

/**
 * Drop `previous` (if still compactable) and apply the renumbering it caused
 * to every tracker on the engine, so no instance is left holding an id that
 * now names a different entry.
 */
const compact = (engine: ClientEngine, previous: number): Effect.Effect<void, StoreError> =>
  // Uninterruptible: once the engine has renumbered the journal, every tracker
  // must hear about it, or a later call would drop an unrelated entry (#249).
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { renumbered } = yield* engine.dropIfPending([previous]);
      if (renumbered.length === 0) return;
      const moves = new Map(renumbered.map(({ from, to }) => [from, to] as const));
      const all = trackersByEngine.get(engine);
      if (all === undefined) return;
      for (const ref of all) {
        const tracker = ref.deref();
        if (tracker === undefined) {
          all.delete(ref);
          continue;
        }
        for (const [key, id] of tracker) {
          const moved = moves.get(id);
          if (moved !== undefined) tracker.set(key, moved);
        }
      }
    })
  );

/** Per-key buffered state shared by `debounce`/`throttle`'s timer loops. */
interface Entry {
  latestArgs: unknown;
  /** Whether `latestArgs` has landed since the last flush for this key. */
  dirty: boolean;
  timer: Fiber.Fiber<void> | undefined;
}

/**
 * Journal `args` for `mutator`/`key` via `mutateWithAck`, then drop this
 * key's previously-tracked mutation id if it is still pending — the shared
 * compaction step every strategy below is built from. `lastIdByKey` is the
 * caller's own bookkeeping (not the engine's): each Paced instance tracks
 * only the ids *it* journaled, so it only ever asks to drop its own entries.
 */
const flush = (
  engine: ClientEngine,
  mutator: string,
  lastIdByKey: Tracker,
  key: string,
  args: unknown
): Effect.Effect<void, MutatorError | StoreError> =>
  Effect.gen(function* () {
    track(engine, lastIdByKey);
    // Journaling and remembering the id are one uninterruptible step (#249
    // review N1): an interrupt between them would leave an entry no tracker
    // knows, which a later compaction could renumber without anyone noticing.
    const previous = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const handle = yield* engine.mutateWithAck(mutator, args);
        const before = lastIdByKey.get(key);
        lastIdByKey.set(key, handle.mutationId);
        return before;
      })
    );
    if (previous !== undefined) yield* compact(engine, previous);
  });

/**
 * A background flush (debounce's trailing edge, throttle's periodic tick)
 * that isn't awaited by any caller: failures would otherwise die silently in
 * the forked fiber, so log them instead. The entry this call would have
 * compacted simply stays journaled uncompacted — never lost, just uncoalesced
 * (the same "short-lived extra entries" tradeoff `coalesce` always accepts).
 */
const flushBackground = (
  engine: ClientEngine,
  mutator: string,
  lastIdByKey: Tracker,
  key: string,
  args: unknown
): Effect.Effect<void> =>
  flush(engine, mutator, lastIdByKey, key, args).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Paced: background flush failed; entry left journaled uncompacted", {
        mutator,
        key,
        error,
      })
    )
  );

/**
 * Coalesce: consecutive unpushed invocations of `mutator` for the same `key`
 * collapse to the last one. No timing — every call journals and compacts
 * immediately, so nothing is ever buffered only in memory (fully durable),
 * at the cost of a momentary extra journal entry between a call and its
 * compaction.
 */
export const coalesce = (engine: ClientEngine, mutator: string): Effect.Effect<PacedMutation> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const lastIdByKey = new Map<string, number>();
    const call: PacedMutation["call"] = (key, args) =>
      Semaphore.withPermit(lock, flush(engine, mutator, lastIdByKey, key, args));
    return { call };
  });

/**
 * Debounce: the first call after a quiet period journals immediately (the
 * overlay renders it right away — optimistic rendering never waits for the
 * window); every call inside the window just buffers its args and restarts
 * the trailing timer. When `duration` elapses with no further calls, the
 * latest buffered args flush once, superseding the leading entry. A 50-call
 * burst inside one window therefore produces exactly two journal writes
 * (leading + trailing) no matter how many calls landed in between — see the
 * module doc for the durability tradeoff this implies.
 */
export const debounce = (
  engine: ClientEngine,
  mutator: string,
  duration: Duration.Input
): Effect.Effect<PacedMutation, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const lastIdByKey = new Map<string, number>();
    const entries = new Map<string, Entry>();

    const trailing = (key: string): Effect.Effect<void> =>
      Effect.sleep(duration).pipe(
        Effect.andThen(
          Semaphore.withPermit(
            lock,
            Effect.gen(function* () {
              const entry = entries.get(key);
              if (entry === undefined || !entry.dirty) {
                entries.delete(key);
                return;
              }
              const args = entry.latestArgs;
              entries.delete(key); // idle again: the next call is a fresh leading edge
              yield* flushBackground(engine, mutator, lastIdByKey, key, args);
            })
          )
        )
      );

    const call: PacedMutation["call"] = (key, args) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const entry = entries.get(key);
          if (entry === undefined) {
            // Leading edge: journal now so the overlay reflects it immediately.
            entries.set(key, { latestArgs: args, dirty: false, timer: undefined });
            yield* flush(engine, mutator, lastIdByKey, key, args);
          } else {
            if (entry.timer !== undefined) yield* Fiber.interrupt(entry.timer);
            entry.latestArgs = args;
            entry.dirty = true;
          }
          entries.get(key)!.timer = yield* Effect.forkIn(trailing(key), scope);
        })
      );

    return { call };
  });

/**
 * Throttle: like {@link debounce}'s leading edge, but the window is never
 * reset by later calls — it flushes at most once per `duration` while calls
 * keep arriving (a continuous drag emits periodic journal writes, not just
 * one at the very end), then goes idle once a window elapses with nothing new
 * buffered.
 */
export const throttle = (
  engine: ClientEngine,
  mutator: string,
  duration: Duration.Input
): Effect.Effect<PacedMutation, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const lastIdByKey = new Map<string, number>();
    const entries = new Map<string, Entry>();

    const tick = (key: string): Effect.Effect<void> =>
      Effect.sleep(duration).pipe(
        Effect.andThen(
          Semaphore.withPermit(
            lock,
            Effect.gen(function* () {
              const entry = entries.get(key);
              if (entry === undefined) return;
              if (!entry.dirty) {
                entries.delete(key); // idle: the next call is a fresh leading edge
                return;
              }
              entry.dirty = false;
              const args = entry.latestArgs;
              yield* flushBackground(engine, mutator, lastIdByKey, key, args);
              entry.timer = yield* Effect.forkIn(tick(key), scope);
            })
          )
        )
      );

    const call: PacedMutation["call"] = (key, args) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const entry = entries.get(key);
          if (entry === undefined) {
            // Leading edge: journal now and start this key's window.
            const created: Entry = { latestArgs: args, dirty: false, timer: undefined };
            entries.set(key, created);
            yield* flush(engine, mutator, lastIdByKey, key, args);
            created.timer = yield* Effect.forkIn(tick(key), scope);
            return;
          }
          // A window is already running for this key: buffer, don't reset it.
          entry.latestArgs = args;
          entry.dirty = true;
        })
      );

    return { call };
  });
