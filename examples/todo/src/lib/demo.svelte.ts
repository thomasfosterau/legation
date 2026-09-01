/**
 * Demo controls context + runes
 *
 * The Client's read/write API is the rune hooks (`useQuery` / `useMutation`).
 * The *demo* knobs — offline toggle, "remote edit", the durable journal,
 * connection status — live outside that API, so they ride a small Svelte
 * context plus two runes built from {@link Demo}.
 *
 * `.svelte.ts` because these helpers own `$state` and `$effect`: the reactive
 * values are plain runes, not stores, so components read `.current` directly
 * with no `$` auto-subscription.
 */
import { getContext, setContext } from "svelte";
import { Effect, Fiber, Stream } from "effect";
import type { Connection, Demo, PendingEntry } from "./sync";

const DEMO_KEY = Symbol("todo/demo");

export const setDemo = (demo: Demo): void => {
  setContext(DEMO_KEY, demo);
};

export const getDemo = (): Demo => {
  const demo = getContext<Demo | undefined>(DEMO_KEY);
  if (demo === undefined) throw new Error("setDemo(demo) must be called higher in the tree");
  return demo;
};

/** Live transport connection status (emitted now and on every change). */
export const connectionState = (demo: Demo): { readonly current: Connection } => {
  let status = $state<Connection>("connecting");
  $effect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(demo.connection, (next) => Effect.sync(() => (status = next)))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });
  return {
    get current() {
      return status;
    },
  };
};

/** The durable journal, polled so the panel reflects push acks (which trim it). */
export const pendingState = (demo: Demo): { readonly current: ReadonlyArray<PendingEntry> } => {
  let entries = $state<ReadonlyArray<PendingEntry>>([]);
  $effect(() => {
    let live = true;
    const poll = (): void =>
      void demo.pending().then((next) => {
        if (live) entries = next;
      });
    poll();
    const timer = setInterval(poll, 750);
    return () => {
      live = false;
      clearInterval(timer);
    };
  });
  return {
    get current() {
      return entries;
    },
  };
};
