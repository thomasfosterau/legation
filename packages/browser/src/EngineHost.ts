/**
 * EngineHost
 *
 * The host side of the tab-mirror protocol (ADR-0010): serves a running
 * ClientEngine to tab mirrors over a MirrorChannel. Mutations forward into
 * the engine's journal (optimism included — the engine's change event
 * re-broadcasts materialized rows to every tab); subset subscriptions are
 * registered with the engine and their live results broadcast on every
 * change.
 *
 * Subscription bookkeeping is set-based, not refcounted: `Unsubscribe`
 * tears the subset down for every tab. Multi-tab refcounting (requires tab
 * identity + disconnect detection) is a planned refinement.
 */

import { ClientEngine, Subset } from "@thomasfosterau/effect-sync-core";
import { Effect, Fiber, Ref, Scope, Stream } from "effect";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

export interface EngineHostOptions {
  readonly channel: MirrorChannel;
  readonly engine: ClientEngine.ClientEngine;
}

/**
 * Serve the engine over the channel. The inbound subscription is
 * established before this effect completes; message handling runs on a
 * scoped background fiber.
 */
export const run = (options: EngineHostOptions): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { channel, engine } = options;
    const inbox = yield* channel.subscribe;
    const broadcasting = yield* Ref.make(new Map<string, Fiber.Fiber<void, never>>());

    const broadcast = (key: string, rows: ReadonlyArray<ClientEngine.LocalRow>) =>
      channel.post(MirrorProtocol.mirrorUpdate(key, rows));

    const handleSubscribe = (subset: Subset.Subset) =>
      Effect.gen(function* () {
        const key = Subset.hash(subset);
        const fibers = yield* Ref.get(broadcasting);
        if (fibers.has(key)) {
          // Already broadcasting: hydrate the (possibly new) tab once.
          return yield* engine.query(subset).pipe(Effect.flatMap((rows) => broadcast(key, rows)));
        }
        yield* engine.subscribe(subset);
        // `observe` emits the current rows first, hydrating the subscriber.
        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(engine.observe(subset), (rows) => broadcast(key, rows)).pipe(
            Effect.ignore
          )
        );
        yield* Ref.update(broadcasting, (map) => new Map(map).set(key, fiber));
      });

    const handleUnsubscribe = (subset: Subset.Subset) =>
      Effect.gen(function* () {
        const key = Subset.hash(subset);
        const fiber = (yield* Ref.get(broadcasting)).get(key);
        if (fiber === undefined) return;
        yield* Fiber.interrupt(fiber);
        yield* engine.unsubscribe(subset);
        yield* Ref.update(broadcasting, (map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
      });

    const handle = (message: MirrorProtocol.TabMessage) => {
      switch (message._tag) {
        case "Mutate":
          return engine.mutateEncoded(message.mutator, message.args).pipe(
            Effect.flatMap(() => channel.post({ _tag: "MutateAck", requestId: message.requestId })),
            Effect.catch((error) =>
              channel.post({
                _tag: "MutateError",
                requestId: message.requestId,
                message: error.message,
              })
            )
          );
        case "Subscribe":
          return handleSubscribe(message.subset);
        case "Unsubscribe":
          return handleUnsubscribe(message.subset);
      }
    };

    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap(MirrorProtocol.decodeTabMessage),
          Effect.flatMap((message) =>
            message === undefined ? Effect.void : handle(message).pipe(Effect.ignore)
          )
        )
      )
    );
  });
