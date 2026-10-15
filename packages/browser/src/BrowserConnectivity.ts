/**
 * BrowserConnectivity
 *
 * Signals belong at the transport seam, not in core (issue #33). This layers
 * the browser's connectivity and focus signals onto any `ClientTransport`:
 *
 * - `navigator.onLine` is **combined with the wrapped transport's own status**
 *   (worst of the two wins), so a carrier with real awareness —
 *   `Transport.withInferredStatus`, `withFallback`, a status-aware socket —
 *   keeps its signal, while the browser adds what only it knows (the radio is
 *   off). For carriers that report themselves permanently "connected" (the
 *   plain RPC transport), the navigator signal is the truthful one.
 * - Where there is a `window` (a page), the `online`/`offline` events drive
 *   that signal. A service worker has no `window` and no such events, so there
 *   the signal is a probe instead: `navigator.onLine` is read every
 *   `pollInterval` and a status change is emitted when it flips (#328). The
 *   reconnect edge then reaches the sync loop as it would from an event.
 * - `visibilitychange` to visible surfaces a poke ("pull soon"), so returning
 *   to a tab converges it — the browser analogue of TanStack Query's window
 *   focus refetching.
 *
 * push/pull pass straight through; only `status`, `statusChanges`, and `pokes`
 * are augmented. All listeners and probes are torn down when the scope closes.
 *
 * `statusChanges` has one addition to the combination above: the reconnect
 * edge. Each navigator `disconnected` → `connected` flip emits `connected`
 * once, even while the carrier still reports `disconnected` (#328). The sync
 * loop's push and pull therefore run at once, and a carrier that really is
 * down fails that push and backs off as usual. The next change then emits the
 * combined value again, which may read `disconnected`. `status` is not
 * affected: it always reads the worst of the two signals.
 *
 * Auto-push does not consult this status, by design (#328). A push attempted
 * while `disconnected` goes out anyway: `navigator.onLine` is a hint and can be
 * wrong (in #315 it read `false` while the worker's WebSocket still worked),
 * and a failed push already backs off on its own retry policy. The reconnect
 * edge runs an immediate push and pull, so a journal that a failed push left
 * behind drains as soon as the navigator reports the return, without waiting on
 * the backoff.
 */

import { Transport } from "@thomasfosterau/legation-effect";
import type { Protocol } from "@thomasfosterau/legation-effect/internal";
import { Duration, Effect, Queue, Schedule, Scope, Stream, SubscriptionRef } from "effect";

/**
 * Options for {@link withBrowserConnectivity}.
 */
export interface BrowserConnectivityOptions {
  /**
   * How often a runtime with no `window` (a service worker) reads
   * `navigator.onLine` to detect a flip, since it has no `online`/`offline`
   * events. Defaults to `"5 seconds"`. The interval bounds how long a
   * reconnect takes to reach the sync loop. Ignored where `window` exists.
   */
  readonly pollInterval?: Duration.Input | undefined;
}

/** The global `navigator` when it reports `onLine`, else undefined (SSR, or a runtime without it). */
const globalNavigator = (): Navigator | undefined =>
  typeof globalThis.navigator === "object" && typeof globalThis.navigator.onLine === "boolean"
    ? globalThis.navigator
    : undefined;

/** Current `navigator.onLine` on the global scope, treating a missing navigator as online. */
const navigatorOnline = (): boolean => globalNavigator()?.onLine ?? true;

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
 * surfaces a poke. Where there is no `window` (a service worker), the
 * navigator signal is probed every `pollInterval` instead of listened for.
 * Scoped: forked fibres and DOM listeners are torn down when the scope closes.
 */
export const withBrowserConnectivity = (
  transport: Transport.ClientTransport,
  options: BrowserConnectivityOptions = {}
): Effect.Effect<Transport.ClientTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const win: EventTarget | undefined = typeof window !== "undefined" ? window : undefined;
    const doc: (EventTarget & { readonly visibilityState?: string }) | undefined =
      typeof document !== "undefined" ? document : undefined;

    // Read once, at construction: the initial status and the probe's baseline
    // are the same reading.
    const initialOnline = navigatorOnline();
    const status = yield* SubscriptionRef.make<Transport.ConnectionStatus>(
      initialOnline ? "connected" : "disconnected"
    );
    // DOM callbacks are synchronous; bridge them into Effect via unsafe offers.
    const statusEvents = yield* Queue.unbounded<Transport.ConnectionStatus>();
    const focusPokes = yield* Queue.unbounded<Protocol.Poke>();

    yield* Effect.forkScoped(
      Stream.fromQueue(statusEvents).pipe(
        Stream.runForEach((next) => SubscriptionRef.set(status, next))
      )
    );

    if (win !== undefined) {
      yield* onEvent(win, "online", () => Queue.offerUnsafe(statusEvents, "connected"));
      yield* onEvent(win, "offline", () => Queue.offerUnsafe(statusEvents, "disconnected"));
    } else if (globalNavigator() !== undefined) {
      // No window, so no online/offline events: probe the navigator for a flip.
      // The last reading is compared, not the status ref, so a flip is emitted
      // once and an unchanged reading emits nothing.
      let lastOnline = initialOnline;
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.sync(() => {
            const online = navigatorOnline();
            if (online !== lastOnline) {
              lastOnline = online;
              Queue.offerUnsafe(statusEvents, online ? "connected" : "disconnected");
            }
          }),
          Schedule.spaced(options.pollInterval ?? "5 seconds")
        )
      );
    }
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
      // The reconnect edge: a navigator flip from `disconnected` to `connected`
      // emits `connected` even if the carrier reads `disconnected` (#328).
      statusChanges: Stream.zipLatest(
        SubscriptionRef.changes(status),
        transport.statusChanges
      ).pipe(
        Stream.mapAccum(
          (): Transport.ConnectionStatus | undefined => undefined,
          (previousNavigator, [navigatorStatus, transportStatus]) => {
            const reconnect =
              previousNavigator === "disconnected" && navigatorStatus === "connected";
            const emitted = reconnect ? "connected" : worst(navigatorStatus, transportStatus);
            return [navigatorStatus, [emitted]] as const;
          }
        ),
        Stream.changesWith((a, b) => a === b)
      ),
    };
  });
