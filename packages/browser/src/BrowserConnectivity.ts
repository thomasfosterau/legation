/**
 * BrowserConnectivity
 *
 * Signals belong at the transport seam, not in core (issue #33). This layers
 * the browser's connectivity and focus signals onto any `ClientTransport`:
 *
 * - `navigator.onLine` + `online`/`offline` events are **combined with the
 *   wrapped transport's own status** (worst of the two wins), so a carrier
 *   with real awareness — `Transport.withInferredStatus`, `withFallback`, a
 *   status-aware socket — keeps its signal, while the browser adds what only
 *   it knows (the radio is off). For carriers that report themselves
 *   permanently "connected" (the plain RPC transport), the navigator signal
 *   is the truthful one.
 * - `visibilitychange` to visible surfaces a poke ("pull soon"), so returning
 *   to a tab converges it — the browser analogue of TanStack Query's window
 *   focus refetching.
 *
 * push/pull pass straight through; only `status`, `statusChanges`, and `pokes`
 * are augmented. All listeners are unregistered when the scope closes.
 */

import { Transport } from "@legation/effect";
import type { Protocol } from "@legation/effect";
import { Effect, Queue, Scope, Stream, SubscriptionRef } from "effect";

/** Current `navigator.onLine`, treating a missing navigator as online. */
const navigatorOnline = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
    ? navigator.onLine
    : true;

/**
 * Register a DOM event listener on `target` for the scope's lifetime. No-op
 * when `target` is undefined (e.g. server-side rendering).
 */
const onEvent = (
  target: EventTarget | undefined,
  type: string,
  handler: () => void
): Effect.Effect<void, never, Scope.Scope> =>
  target === undefined
    ? Effect.void
    : Effect.acquireRelease(
        Effect.sync(() => {
          target.addEventListener(type, handler);
        }),
        () => Effect.sync(() => target.removeEventListener(type, handler))
      ).pipe(Effect.asVoid);

/** The pessimistic combination of two status signals. */
const worst = (
  a: Transport.ConnectionStatus,
  b: Transport.ConnectionStatus
): Transport.ConnectionStatus =>
  a === "disconnected" || b === "disconnected"
    ? "disconnected"
    : a === "connecting" || b === "connecting"
      ? "connecting"
      : "connected";

/**
 * Wrap a `ClientTransport` so its connection status combines
 * `navigator.onLine` with the transport's own signal, and a return-to-visible
 * surfaces a poke. Scoped: forked fibres and DOM listeners are torn down when
 * the scope closes.
 */
export const withBrowserConnectivity = (
  transport: Transport.ClientTransport
): Effect.Effect<Transport.ClientTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const win: EventTarget | undefined = typeof window !== "undefined" ? window : undefined;
    const doc: (EventTarget & { readonly visibilityState?: string }) | undefined =
      typeof document !== "undefined" ? document : undefined;

    const status = yield* SubscriptionRef.make<Transport.ConnectionStatus>(
      navigatorOnline() ? "connected" : "disconnected"
    );
    // DOM callbacks are synchronous; bridge them into Effect via unsafe offers.
    const statusEvents = yield* Queue.unbounded<Transport.ConnectionStatus>();
    const focusPokes = yield* Queue.unbounded<Protocol.Poke>();

    yield* Effect.forkScoped(
      Stream.fromQueue(statusEvents).pipe(
        Stream.runForEach((next) => SubscriptionRef.set(status, next))
      )
    );

    yield* onEvent(win, "online", () => Queue.offerUnsafe(statusEvents, "connected"));
    yield* onEvent(win, "offline", () => Queue.offerUnsafe(statusEvents, "disconnected"));
    yield* onEvent(doc, "visibilitychange", () => {
      if (doc?.visibilityState === "visible") {
        Queue.offerUnsafe(focusPokes, { reason: "visibilitychange" });
      }
    });

    return {
      push: transport.push,
      pull: transport.pull,
      pokes: Stream.merge(transport.pokes, Stream.fromQueue(focusPokes)),
      status: Effect.zipWith(SubscriptionRef.get(status), transport.status, worst),
      // Both sources emit their current value first (the seam's contract), so
      // the combination emits promptly; dedup keeps reconnect triggers calm.
      statusChanges: Stream.zipLatest(
        SubscriptionRef.changes(status),
        transport.statusChanges
      ).pipe(
        Stream.map(([navigatorStatus, transportStatus]) => worst(navigatorStatus, transportStatus)),
        Stream.changesWith((a, b) => a === b)
      ),
    };
  });
