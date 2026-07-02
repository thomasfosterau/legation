/**
 * Live query stores
 *
 * `query` / `namedQuery` bridge a live query (an Effect `Stream` over the
 * mirror) to a Svelte `Readable` store: the store's `start` callback forks the
 * engine's `observe` in a fiber and pushes each snapshot through `set`; the
 * returned `stop` callback interrupts that fiber when the last subscriber
 * unsubscribes. Read them with Svelte's `$store` auto-subscription, so the
 * component re-renders on every local change (mutation, push ack, pull/rebase).
 */
import { readable, type Readable } from "svelte/store";
import { Effect, Fiber, Stream } from "effect";
import { ClientEngine, type Subset } from "@legation/effect";
import { getEngineRuntime, type EffectSyncRuntime } from "./runtime.js";

/** A live query snapshot: the materialised rows (confirmed + overlay). */
export type Rows = ReadonlyArray<ClientEngine.LocalRow>;
const EMPTY: Rows = [];

const makeStore = (
  runtime: EffectSyncRuntime,
  toStream: (engine: ClientEngine.ClientEngine) => Stream.Stream<Rows, unknown>
): Readable<Rows> =>
  readable<Rows>(EMPTY, (set) => {
    const run = Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
      Stream.runForEach(toStream(engine), (rows) => Effect.sync(() => set(rows)))
    ).pipe(Effect.catchCause(() => Effect.void));
    const fiber = runtime.runFork(run);
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  });

/** Live result of a subset, re-emitting on every local change. */
export const query = (subset: Subset.Subset): Readable<Rows> =>
  makeStore(getEngineRuntime(), (engine) => engine.observe(subset));

/** Live result of a named query (Query.ts). */
export const namedQuery = (name: string, args: unknown): Readable<Rows> =>
  makeStore(getEngineRuntime(), (engine) => engine.observeNamed(name, args));
