/**
 * BackgroundSync (#213): a journal written offline flushes after its tab has
 * closed, through the ordinary push path.
 *
 * Every test drives the worker side with a fake `self` — an object with
 * `addEventListener` and a `registration` — and no network: the transport is
 * the in-memory one over a real `SyncServer` and `MemoryBackend`, so the
 * ledger's exactly-once and permanent-rejection semantics are the real ones.
 * The transport starts `disconnected`, so the sync loop's own reconnect push
 * never fires and only a `sync` event can move the journal.
 *
 * Behavioural spec: Gardeneria's `apps/service-worker` outbox (its `onSync`
 * answers one tag; its page-side registration is best-effort). Two of its
 * behaviours are deliberately *not* matched: a refused write is surfaced as
 * `rejected` rather than discarded, and a transport failure rejects the
 * event so the browser reschedules it rather than resolving it silently.
 */
import {
  Authorization,
  Backend,
  ClientStore,
  type Identity,
  MemoryBackend,
  MutationRejected,
  Mutator,
  Transport,
  TransportError,
} from "@legation/effect";
import { ClientEngine, Cvr, InvalidationBus, Subset, SyncServer } from "@legation/effect/internal";
import type { Protocol } from "@legation/effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Effect, HashMap, Option, Ref, Schema, Stream } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import * as BackgroundSync from "../BackgroundSync.js";
import * as ServiceWorkerHost from "../ServiceWorkerHost.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
  {
    mutator: Mutator.make("todo/refused", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  // A write the backend can never accept: the permanent-rejection path.
  "todo/refused": () => Effect.fail(new MutationRejected({ reason: "not allowed" })),
};

const allTodos = Subset.make({ collection: "todos" });

const ALICE: Identity.Fingerprint = "sha256:alice-subject-hash";
const BOB: Identity.Fingerprint = "sha256:bob-subject-hash";

// ─── The fake worker scope ───────────────────────────────────────────────────

interface Dispatched {
  /** Every promise the listener handed to `waitUntil`. */
  readonly held: Array<Promise<unknown>>;
}

/** A stand-in for `self`: one `sync` listener slot and a registration. */
const fakeScope = (registration: BackgroundSync.SyncRegistration = {}) => {
  const listeners: Array<(event: BackgroundSync.SyncEvent) => void> = [];
  const scope: BackgroundSync.SyncScope = {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    registration,
  };
  /** Fire a `sync` event for `tag`, as the browser would on a wake. */
  const dispatch = (tag: string, lastChance = false): Dispatched => {
    const held: Array<Promise<unknown>> = [];
    const event: BackgroundSync.SyncEvent = {
      tag,
      lastChance,
      waitUntil: (promise) => {
        held.push(promise);
      },
    };
    for (const listener of listeners) listener(event);
    return { held };
  };
  return { scope, dispatch, listeners };
};

/** A `SyncManager` that records the tags registered with it. */
const recordingSyncManager = () => {
  const tags: Array<string> = [];
  const sync: BackgroundSync.SyncManager = {
    register: (tag) => {
      tags.push(tag);
      return Promise.resolve();
    },
  };
  return { sync, tags };
};

/** Await a held `waitUntil` promise, as its outcome or its rejection. */
const settle = (promise: Promise<unknown> | undefined) =>
  Effect.promise(() =>
    (promise ?? Promise.reject(new Error("nothing was held"))).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
  );

// ─── The engine under test ───────────────────────────────────────────────────

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
});

/**
 * An engine over `store` and an in-memory transport that records every push
 * and can be made to fail one. The transport reports `disconnected`, so no
 * push happens unless something asks for one.
 */
const makeEngine = (store: ClientStore.ClientStore) =>
  Effect.gen(function* () {
    const handler = yield* makeServer;
    const inner = yield* Transport.makeInMemory(handler, "group-bg");
    yield* inner.setStatus("disconnected");
    const pushes = yield* Ref.make<ReadonlyArray<Protocol.PushRequest>>([]);
    const offline = yield* Ref.make(false);
    const transport: Transport.ClientTransport = {
      ...inner,
      push: (request) =>
        Ref.get(offline).pipe(
          Effect.flatMap((down) =>
            down
              ? Effect.fail(new TransportError({ message: "offline" }))
              : Ref.update(pushes, (seen) => [...seen, request]).pipe(
                  Effect.andThen(inner.push(request))
                )
          )
        ),
    };
    const engine = yield* ClientEngine.make({
      clientId: "client-bg",
      clientGroupId: "group-bg",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    yield* engine.subscribe(allTodos);
    return { engine, store, pushes, offline };
  });

const phases = (engine: ClientEngine.ClientEngine) =>
  Stream.runHead(engine.mutationStates).pipe(
    Effect.map((head) =>
      Option.match(head, {
        onNone: () => [],
        onSome: (map) =>
          [...HashMap.values(map)]
            .map(({ mutator, phase, reason }) =>
              reason === undefined ? { mutator, phase } : { mutator, phase, reason }
            )
            .toSorted((a, b) => a.mutator.localeCompare(b.mutator)),
      })
    )
  );

const titles = (rows: ReadonlyArray<{ readonly value: unknown }>) =>
  rows.map((row) => (row.value as Todo).title).toSorted();

/** Poll `check` until it holds (real time), or fail the test after ~2s. */
const eventually = <A, E>(read: Effect.Effect<A, E>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = yield* read;
      if (check(value)) return value;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error("condition never held"));
  });

const uniqueChannel = () => `legation-bg-${Math.random().toString(36).slice(2)}`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BackgroundSync (#213)", () => {
  it.live(
    "journal → sync event → push → acknowledgement → overlay drop, composed into ServiceWorkerHost",
    () =>
      Effect.gen(function* () {
        const { sync, tags } = recordingSyncManager();
        const self = fakeScope({ sync });
        // Top-level installation, before any engine exists: the order a
        // worker woken by the browser for a `sync` event actually runs in.
        const listener = BackgroundSync.listen({ scope: self.scope });

        const { engine, store, pushes } = yield* makeEngine(yield* ClientStore.makeMemory);
        yield* engine.mutate("todo/set", { id: "1", title: "written offline" });
        yield* engine.mutate("todo/refused", { id: "2", title: "the backend refuses" });
        // Both writes are visible optimistically, and nothing has been pushed.
        expect(titles(yield* engine.query(allTodos))).toEqual([
          "the backend refuses",
          "written offline",
        ]);
        expect(yield* store.pendingMutations).toHaveLength(2);

        // The tab is gone; the browser wakes the worker with the library's
        // tag before the host has booted. The event is held open.
        const woken = self.dispatch(BackgroundSync.defaultTag);
        expect(woken.held).toHaveLength(1);
        expect(yield* Ref.get(pushes)).toEqual([]);

        // The host boots and attaches its engine; the held event flushes.
        yield* ServiceWorkerHost.start({
          channelName: uniqueChannel(),
          backgroundSync: listener,
        }).pipe(Effect.provideService(ClientEngine.ClientEngine, engine));
        const settled = yield* settle(woken.held[0]);
        expect(settled).toEqual({ ok: true, value: "Flushed" });

        // One push, carrying the whole journal in order — `push`, not a
        // bespoke replay loop.
        const sent = yield* Ref.get(pushes);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.mutations.map((m) => m.mutator)).toEqual(["todo/set", "todo/refused"]);
        // Acknowledged: the journal is trimmed...
        expect(yield* store.pendingMutations).toEqual([]);
        // ...the refused write's optimistic effect is dropped...
        expect(titles(yield* engine.query(allTodos))).not.toContain("the backend refuses");
        // ...and the refusal is surfaced with its reason, not discarded.
        expect(yield* phases(engine)).toEqual([
          { mutator: "todo/refused", phase: "rejected", reason: "not allowed" },
          { mutator: "todo/set", phase: "acknowledged" },
        ]);

        // While the host serves, a journaled mutation registers the tag
        // (the worker is where a mirror's write is journaled).
        yield* engine.mutate("todo/set", { id: "3", title: "later" });
        yield* eventually(
          Effect.sync(() => tags),
          (seen) => seen.includes(BackgroundSync.defaultTag)
        );
      }).pipe(Effect.scoped),
    20_000
  );

  it.live("answers only its own tag: a foreign tag is left alone and pushes nothing", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = BackgroundSync.listen({ scope: self.scope });
      const { engine, store, pushes } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* listener.serve(engine);
      yield* engine.mutate("todo/set", { id: "1", title: "pending" });

      const foreign = self.dispatch("someone-elses-outbox");
      // Not even a `waitUntil`: the tag's owner decides that event's outcome.
      expect(foreign.held).toEqual([]);
      yield* Effect.sleep("50 millis");
      expect(yield* Ref.get(pushes)).toEqual([]);
      expect(yield* store.pendingMutations).toHaveLength(1);

      // A custom tag is answered instead of the default, never as well as.
      const custom = BackgroundSync.listen({ scope: self.scope, tag: "my-app-flush" });
      yield* custom.serve(engine);
      expect(self.dispatch("my-app-flush").held).toHaveLength(1);
    }).pipe(Effect.scoped)
  );

  it.live("a transport failure rejects the event so the browser reschedules, journal intact", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = BackgroundSync.listen({ scope: self.scope });
      const { engine, store, offline } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* listener.serve(engine);
      yield* engine.mutate("todo/set", { id: "1", title: "pending" });

      yield* Ref.set(offline, true);
      const failed = yield* settle(self.dispatch(BackgroundSync.defaultTag, true).held[0]);
      expect(failed.ok).toBe(false);
      expect(yield* store.pendingMutations).toHaveLength(1);

      // The browser's retry (or any later connectivity signal) succeeds.
      yield* Ref.set(offline, false);
      const retried = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(retried).toEqual({ ok: true, value: "Flushed" });
      expect(yield* store.pendingMutations).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.live("with no host attached in time, the event rejects rather than hanging the worker", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      BackgroundSync.listen({ scope: self.scope, readyTimeout: "50 millis" });
      const result = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(result.ok).toBe(false);
      expect(result.ok === false && (result.error as { _tag?: string })._tag).toBe("HostNotReady");
    })
  );

  it.live("a closed host detaches: a later event waits for the next host", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = BackgroundSync.listen({ scope: self.scope, readyTimeout: "100 millis" });
      const { engine } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* Effect.scoped(listener.serve(engine));
      const result = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(result.ok).toBe(false);
    }).pipe(Effect.scoped)
  );

  describe("the identity boundary (#212)", () => {
    it.live("a sync event does not push a quarantined journal", () =>
      Effect.gen(function* () {
        const self = fakeScope();
        const listener = BackgroundSync.listen({ scope: self.scope });
        const store = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const { engine, pushes } = yield* makeEngine(store);
        yield* listener.serve(engine);

        yield* engine.mutate("todo/set", { id: "1", title: "alice's unsynced write" });
        // Alice signs out and Bob signs in: her write is quarantined.
        const reset = yield* engine.reset(BOB);
        expect(reset).toMatchObject({ transition: "Reset", quarantined: 1 });

        const settled = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(settled).toEqual({ ok: true, value: "Flushed" });
        // Nothing went out under Bob's session, and Alice's write is held,
        // not lost.
        expect(yield* Ref.get(pushes)).toEqual([]);
        expect(yield* engine.quarantinedMutations(ALICE)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
    );

    it.live("a replica stamped for someone other than the current identity is not flushed", () =>
      Effect.gen(function* () {
        // The tab closed before the app called `reset`: the store is still
        // stamped for Alice, but Bob is who the app now says is signed in.
        const current = yield* Ref.make<Identity.Fingerprint | undefined>(BOB);
        const self = fakeScope();
        const listener = BackgroundSync.listen({ scope: self.scope, identity: Ref.get(current) });
        const store = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const { engine, pushes } = yield* makeEngine(store);
        yield* listener.serve(engine);
        yield* engine.mutate("todo/set", { id: "1", title: "alice's unsynced write" });

        const skipped = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(skipped).toEqual({ ok: true, value: "IdentityChanged" });
        expect(yield* Ref.get(pushes)).toEqual([]);
        expect(yield* store.pendingMutations).toHaveLength(1);

        // "Cannot tell who is signed in" skips too.
        yield* Ref.set(current, undefined);
        const unknown = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(unknown).toEqual({ ok: true, value: "IdentityChanged" });
        expect(yield* Ref.get(pushes)).toEqual([]);

        // Alice is signed in again: her journal is hers to push.
        yield* Ref.set(current, ALICE);
        const flushed = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(flushed).toEqual({ ok: true, value: "Flushed" });
        expect(yield* Ref.get(pushes)).toHaveLength(1);
        expect(yield* store.pendingMutations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
    );
  });
});
