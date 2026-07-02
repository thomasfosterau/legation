/**
 * BrowserConnectivity
 *
 * Signals belong at the transport seam, not in core (issue #33). This layers
 * the browser's connectivity and focus signals onto any `ClientTransport`:
 *
 * - `navigator.onLine` + `online`/`offline` events drive a truthful
 *   `statusChanges` stream, so the sync loop's push+pull-on-reconnect trigger
 *   actually fires for carriers (like the RPC transport) that otherwise report
 *   themselves permanently "connected".
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

/**
 * Wrap a `ClientTransport` so its connection status tracks `navigator.onLine`
 * and a return-to-visible surfaces a poke. Scoped: forked fibres and DOM
 * listeners are torn down when the scope closes.
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
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status),
    };
  });
