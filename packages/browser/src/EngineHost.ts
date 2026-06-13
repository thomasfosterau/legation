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
 * Subscriptions are refcounted by tab: a subset's engine subscription and
 * broadcast fiber start when its first tab subscribes and stop only when
 * the last tab unsubscribes or disconnects. `Disconnect` releases every
 * subset a departing tab held — the close-time signal that stands in for
 * the disconnect detection a BroadcastChannel can't provide on its own.
 */

import { ClientEngine, Subset } from "@thomasfosterau/effect-sync-core";
import { Effect, Fiber, Ref, Scope, Stream } from "effect";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

export interface EngineHostOptions {
  readonly channel: MirrorChannel;
  readonly engine: ClientEngine.ClientEngine;
}

/** One actively-broadcast subset: which tabs hold it, and its fiber. */
interface Active {
  readonly subset: Subset.Subset;
  readonly tabs: ReadonlySet<string>;
  readonly fiber: Fiber.Fiber<void, never>;
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
    const active = yield* Ref.make(new Map<string, Active>());

    const broadcast = (key: string, rows: ReadonlyArray<ClientEngine.LocalRow>) =>
      channel.post(MirrorProtocol.mirrorUpdate(key, rows));

    const handleSubscribe = (tabId: string, subset: Subset.Subset) =>
      Effect.gen(function* () {
        const key = Subset.hash(subset);
        const existing = (yield* Ref.get(active)).get(key);
        if (existing !== undefined) {
          // Already broadcasting: refcount this tab and hydrate it once.
          yield* Ref.update(active, (map) =>
            new Map(map).set(key, {
              ...existing,
              tabs: new Set(existing.tabs).add(tabId),
            })
          );
          return yield* engine.query(subset).pipe(Effect.flatMap((rows) => broadcast(key, rows)));
        }
        yield* engine.subscribe(subset);
        // `observe` emits the current rows first, hydrating the subscriber.
        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(engine.observe(subset), (rows) => broadcast(key, rows)).pipe(
            Effect.ignore
          )
        );
        yield* Ref.update(active, (map) =>
          new Map(map).set(key, { subset, tabs: new Set([tabId]), fiber })
        );
      });

    /** Drop one tab from one subset; tear the subset down if it was the last. */
    const release = (tabId: string, key: string) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(active)).get(key);
        if (entry === undefined || !entry.tabs.has(tabId)) return;
        const tabs = new Set(entry.tabs);
        tabs.delete(tabId);
        if (tabs.size > 0) {
          yield* Ref.update(active, (map) => new Map(map).set(key, { ...entry, tabs }));
          return;
        }
        yield* Fiber.interrupt(entry.fiber);
        yield* engine.unsubscribe(entry.subset);
        yield* Ref.update(active, (map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
      });

    const handleDisconnect = (tabId: string) =>
      Effect.gen(function* () {
        const keys = [...(yield* Ref.get(active)).values()]
          .filter((entry) => entry.tabs.has(tabId))
          .map((entry) => Subset.hash(entry.subset));
        for (const key of keys) yield* release(tabId, key);
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
          return handleSubscribe(message.tabId, message.subset);
        case "Unsubscribe":
          return release(message.tabId, Subset.hash(message.subset));
        case "Disconnect":
          return handleDisconnect(message.tabId);
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
