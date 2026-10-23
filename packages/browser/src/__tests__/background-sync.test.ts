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
 * Behavioural spec: a hand-rolled HTTP-replay outbox (its `sync` handler
 * answers one tag; its page-side registration is best-effort). Two of its
 * behaviours are deliberately *not* matched: a refused write is surfaced as
 * `rejected` rather than discarded, and a transport failure rejects the
 * event so the browser reschedules it rather than resolving it silently.
 *
 * Registration is gated (#246): only a mutation journaled offline, or a
 * terminally failed push, registers the tag. The coalescing test uses a
 * `SyncManager` that fires `sync` the moment a tag is registered — what
 * Chromium does online — to show online writes still coalesce.
 */
import {
  Authorization,
  Backend,
  ClientStore,
  Identity,
  MemoryBackend,
  MutationRejected,
  Mutator,
  StoreError,
  Transport,
  TransportError,
  VersionNotSupportedError,
} from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  Cvr,
  InvalidationBus,
  Paced,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import type { Protocol } from "@thomasfosterau/legation-effect/internal";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { KeyValueStore } from "effect/persistence";
import * as BackgroundSync from "../BackgroundSync.js";
import * as ServiceWorkerHost from "../ServiceWorkerHost.js";
import { defined } from "./defined.js";

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

/**
 * A stand-in for `self`: `sync` listener slots and a registration whose
 * `SyncManager` records every tag registered. With `firesOnRegister` it also
 * dispatches that tag's `sync` event straight away, as Chromium does online,
 * and keeps what the listeners held in `fired`.
 */
const fakeScope = (options: { readonly firesOnRegister?: boolean } = {}) => {
  const listeners: Array<(event: BackgroundSync.SyncEvent) => void> = [];
  const tags: Array<string> = [];
  const fired: Array<Promise<unknown>> = [];
  /** Fire a `sync` event for `tag`, as the browser would on a wake. */
  const dispatch = (tag: string, lastChance = false): Dispatched => {
    const held: Array<Promise<unknown>> = [];
    const event: BackgroundSync.SyncEvent = {
      tag,
      lastChance,
      waitUntil: (promise) => {
        // The browser consumes a held promise; so does this fake, so a
        // rejection nobody has awaited yet is not an unhandled one.
        promise.catch(() => undefined);
        held.push(promise);
      },
    };
    for (const listener of listeners) listener(event);
    return { held };
  };
  const sync: BackgroundSync.SyncManager = {
    register: (tag) => {
      tags.push(tag);
      if (options.firesOnRegister === true) fired.push(...dispatch(tag).held);
      return Promise.resolve();
    },
  };
  const scope: BackgroundSync.SyncScope = {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    registration: { sync },
  };
  return { scope, dispatch, tags, fired };
};

/** `listen` over a fake scope, with the identity check off unless given. */
const listenOn = (
  self: ReturnType<typeof fakeScope>,
  options: Omit<BackgroundSync.ListenOptions, "scope" | "identity"> & {
    readonly identity?: BackgroundSync.IdentitySource;
  } = {}
) =>
  BackgroundSync.listen({
    identity: BackgroundSync.identityUnchecked,
    ...options,
    scope: self.scope,
  });

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

type Failure = "none" | "transport" | "version";

/**
 * An engine over `store` and an in-memory transport that records every push
 * and can be made to fail one (`failure`). The transport reports
 * `disconnected`, so no push happens unless something asks for one.
 */
const makeEngine = (
  store: ClientStore.ClientStore,
  options: Partial<
    Pick<ClientEngine.ClientEngineOptions, "syncLoop" | "retry" | "unpulledLimit">
  > = {}
) =>
  Effect.gen(function* () {
    const handler = yield* makeServer;
    const inner = yield* Transport.makeInMemory(handler, "group-bg");
    yield* inner.setStatus("disconnected");
    const pushes = yield* Ref.make<ReadonlyArray<Protocol.PushRequest>>([]);
    const failure = yield* Ref.make<Failure>("none");
    const pullsDown = yield* Ref.make(false);
    const transport: Transport.ClientTransport = {
      ...inner,
      pull: (request) =>
        Ref.get(pullsDown).pipe(
          Effect.flatMap((down) =>
            down ? Effect.fail(new TransportError({ message: "pull down" })) : inner.pull(request)
          )
        ),
      push: (request) =>
        Ref.get(failure).pipe(
          Effect.flatMap((mode) =>
            mode === "transport"
              ? Effect.fail(new TransportError({ message: "offline" }))
              : mode === "version"
                ? Effect.fail(new VersionNotSupportedError({ message: "update needed" }))
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
      ...options,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    yield* engine.subscribe(allTodos);
    return { engine, store, pushes, failure, pullsDown };
  });

/** Every log line at `Warn` or above, with the minimum level lowered to `All`. */
const recordLogs = () => {
  const loud: Array<string> = [];
  const logger = Logger.make((options) => {
    if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Warn")) {
      loud.push(`${options.logLevel}: ${String(options.message)}`);
    }
  });
  const layer = Layer.merge(
    Logger.layer([logger]),
    Layer.succeed(References.MinimumLogLevel)("All")
  );
  return { loud, layer };
};

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

const uniqueChannel = () => `legation-bg-${crypto.randomUUID()}`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BackgroundSync (#213)", () => {
  it.live(
    "journal → sync event → push → acknowledgement → overlay drop, composed into ServiceWorkerHost",
    () =>
      Effect.gen(function* () {
        const self = fakeScope();
        // Top-level installation, before any engine exists: the order a
        // worker woken by the browser for a `sync` event actually runs in.
        const listener = listenOn(self);

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
        expect(defined(sent[0]).mutations.map((m) => m.mutator)).toEqual([
          "todo/set",
          "todo/refused",
        ]);
        // Acknowledged: the journal is trimmed...
        expect(yield* store.pendingMutations).toEqual([]);
        // ...the refused write's optimistic effect is dropped...
        expect(titles(yield* engine.query(allTodos))).not.toContain("the backend refuses");
        // ...and the refusal is surfaced with its reason, not discarded.
        expect(yield* phases(engine)).toEqual([
          { mutator: "todo/refused", phase: "rejected", reason: "not allowed" },
          { mutator: "todo/set", phase: "acknowledged" },
        ]);
      }).pipe(Effect.scoped),
    20_000
  );

  it.live("answers only its own tag: a foreign tag is left alone and pushes nothing", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = listenOn(self);
      const { engine, store, pushes } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* listener.serve(engine);
      yield* engine.mutate("todo/set", { id: "1", title: "pending" });

      const foreign = self.dispatch("someone-elses-outbox");
      // Not even a `waitUntil`: the tag's owner decides that event's outcome.
      expect(foreign.held).toEqual([]);
      yield* Effect.sleep("50 millis");
      expect(yield* Ref.get(pushes)).toEqual([]);
      expect(yield* store.pendingMutations).toHaveLength(1);
    }).pipe(Effect.scoped)
  );

  it.live("a custom tag is answered instead of the default, never as well as", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const custom = listenOn(self, { tag: "my-app-flush" });
      const { engine } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* custom.serve(engine);
      expect(self.dispatch(BackgroundSync.defaultTag).held).toEqual([]);
      const answered = self.dispatch("my-app-flush");
      expect(answered.held).toHaveLength(1);
      expect(yield* settle(answered.held[0])).toEqual({ ok: true, value: "Flushed" });
    }).pipe(Effect.scoped)
  );

  it.live("a transport failure rejects the event so the browser reschedules, journal intact", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = listenOn(self);
      const { engine, store, failure } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* listener.serve(engine);
      yield* engine.mutate("todo/set", { id: "1", title: "pending" });

      yield* Ref.set(failure, "transport");
      const failed = yield* settle(self.dispatch(BackgroundSync.defaultTag, true).held[0]);
      expect(failed.ok).toBe(false);
      expect(yield* store.pendingMutations).toHaveLength(1);

      // The browser's retry (or any later connectivity signal) succeeds.
      yield* Ref.set(failure, "none");
      const retried = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(retried).toEqual({ ok: true, value: "Flushed" });
      expect(yield* store.pendingMutations).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.live(
    "a flush whose pull between chunks fails rejects, never reports Flushed, and the journal waits",
    () =>
      Effect.gen(function* () {
        const self = fakeScope();
        const listener = listenOn(self);
        // A bound of 8 splits nine mutations into chunks of four, with a pull before the second (#429).
        const { engine, store, pushes, pullsDown } = yield* makeEngine(
          yield* ClientStore.makeMemory,
          { unpulledLimit: 8, retry: { pull: Schedule.recurs(0) } }
        );
        yield* listener.serve(engine);
        for (let i = 1; i <= 9; i++) {
          yield* engine.mutate("todo/set", { id: String(i), title: `title ${i}` });
        }

        yield* Ref.set(pullsDown, true);
        const failed = yield* settle(self.dispatch(BackgroundSync.defaultTag, true).held[0]);
        expect(failed.ok).toBe(false);
        // The first chunk went; the pull before the second failed, so the flush stopped there.
        expect((yield* Ref.get(pushes)).map((request) => request.mutations.length)).toEqual([4]);
        expect(yield* store.pendingMutations).toHaveLength(5);

        // The browser's next wake, with pulls back, sends the rest and settles as Flushed.
        yield* Ref.set(pullsDown, false);
        const retried = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(retried).toEqual({ ok: true, value: "Flushed" });
        expect(yield* store.pendingMutations).toEqual([]);
      }).pipe(Effect.scoped),
    20_000
  );

  it.live("a schema-version rejection settles as UpdateNeeded and keeps the journal", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = listenOn(self);
      const { engine, store, failure } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* listener.serve(engine);
      yield* engine.mutate("todo/set", { id: "1", title: "pending" });

      yield* Ref.set(failure, "version");
      const settled = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      // Resolved, not rejected: retrying cannot help until the app updates.
      expect(settled).toEqual({ ok: true, value: "UpdateNeeded" });
      expect(yield* store.pendingMutations).toHaveLength(1);
    }).pipe(Effect.scoped)
  );

  it.live("a store failure rejects the event and is logged at Warn", () =>
    Effect.gen(function* () {
      const logs = recordLogs();
      const self = fakeScope();
      const listener = listenOn(self);
      const inner = yield* ClientStore.makeMemory;
      const broken = yield* Ref.make(false);
      const store: ClientStore.ClientStore = {
        ...inner,
        pendingMutations: Ref.get(broken).pipe(
          Effect.flatMap((down) =>
            down ? Effect.fail(new StoreError({ message: "disk gone" })) : inner.pendingMutations
          )
        ),
      };
      const { engine } = yield* makeEngine(store);
      // The flush runs under the services of whoever attached it.
      yield* listener.serve(engine).pipe(Effect.provide(logs.layer));
      yield* engine.mutate("todo/set", { id: "1", title: "pending" });

      yield* Ref.set(broken, true);
      const failed = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(failed.ok).toBe(false);
      expect(failed.ok === false && (failed.error as { _tag?: string })._tag).toBe("StoreError");
      expect(logs.loud).toHaveLength(1);
      expect(logs.loud[0]).toMatch(/^Warn: .*store/);
    }).pipe(Effect.scoped)
  );

  it.live("with no host attached in time, the event rejects rather than hanging the worker", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      listenOn(self, { readyTimeout: "50 millis" });
      const result = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(result.ok).toBe(false);
      expect(result.ok === false && (result.error as { _tag?: string })._tag).toBe("HostNotReady");
    })
  );

  it.live("a closed host detaches: a later event waits for the next host", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = listenOn(self, { readyTimeout: "100 millis" });
      const { engine } = yield* makeEngine(yield* ClientStore.makeMemory);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* listener.serve(engine);
          // Attached: the event flushes.
          const attached = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
          expect(attached).toEqual({ ok: true, value: "Flushed" });
        })
      );
      // Detached with the scope: the next event finds no host.
      const result = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
      expect(result.ok).toBe(false);
    }).pipe(Effect.scoped)
  );

  describe("registration is gated on the journal being unable to drain (#246)", () => {
    it.live(
      "online writes coalesce into one debounced push; an immediately-firing SyncManager is never asked",
      () =>
        Effect.gen(function* () {
          // Chromium online: a registered tag's `sync` fires at once. Before
          // #246 every journaled mutation registered, so each of these five
          // writes got its own push.
          const self = fakeScope({ firesOnRegister: true });
          const listener = listenOn(self, { offline: Effect.succeed(false) });
          const { engine, store, pushes } = yield* makeEngine(yield* ClientStore.makeMemory, {
            syncLoop: { pushDebounce: "150 millis" },
          });
          yield* listener.serve(engine);
          yield* engine.runSync;
          // Warm up: one write, drained by the loop, proves its debounced
          // trigger is subscribed before the burst (under load a fixed sleep
          // is not enough).
          yield* eventually(
            engine
              .mutate("todo/set", { id: "0", title: "warm-up" })
              // Longer than the debounce window, so a retry never resets it.
              .pipe(Effect.andThen(Effect.sleep("400 millis")), Effect.andThen(Ref.get(pushes))),
            (sent) => Arr.isReadonlyArrayNonEmpty(sent)
          );
          yield* eventually(store.pendingMutations, (pending) => Arr.isReadonlyArrayEmpty(pending));
          yield* Ref.set(pushes, []);

          for (let n = 1; n <= 5; n++) {
            yield* engine.mutate("todo/set", { id: "1", title: `edit ${n}` });
          }
          yield* eventually(store.pendingMutations, (pending) => Arr.isReadonlyArrayEmpty(pending));

          expect(self.tags).toEqual([]);
          expect(self.fired).toEqual([]);
          const sent = yield* Ref.get(pushes);
          expect(sent).toHaveLength(1);
          expect(defined(sent[0]).mutations).toHaveLength(5);
        }).pipe(Effect.scoped),
      30_000
    );

    it.live("online paced compaction is not raced by a sync-triggered push", () =>
      Effect.gen(function* () {
        // `dropIfPending` refuses while a push is in flight, so a push fired
        // by every registration would leave every superseded entry in place.
        const self = fakeScope({ firesOnRegister: true });
        const listener = listenOn(self, { offline: Effect.succeed(false) });
        const { engine, store, pushes } = yield* makeEngine(yield* ClientStore.makeMemory);
        yield* listener.serve(engine);
        const paced = yield* Paced.coalesce(engine, "todo/set");

        for (let n = 1; n <= 5; n++) {
          yield* paced.call("1", { id: "1", title: `edit ${n}` });
        }
        yield* Effect.sleep("50 millis");

        expect(self.tags).toEqual([]);
        expect(self.fired).toEqual([]);
        expect(yield* Ref.get(pushes)).toEqual([]);
        // Compacted to the last edit.
        const pending = yield* store.pendingMutations;
        expect(pending.map((m) => (m.args as Todo).title)).toEqual(["edit 5"]);
      }).pipe(Effect.scoped)
    );

    it.live("a mutation journaled offline registers the tag", () =>
      Effect.gen(function* () {
        const network = yield* Ref.make<"online" | "offline">("online");
        const self = fakeScope();
        const listener = listenOn(self, {
          offline: Ref.get(network).pipe(Effect.map((state) => state === "offline")),
        });
        const { engine } = yield* makeEngine(yield* ClientStore.makeMemory);
        yield* listener.serve(engine);

        yield* engine.mutate("todo/set", { id: "1", title: "online" });
        yield* Effect.sleep("50 millis");
        expect(self.tags).toEqual([]);

        yield* Ref.set(network, "offline");
        yield* engine.mutate("todo/set", { id: "2", title: "offline" });
        yield* eventually(
          Effect.sync(() => self.tags),
          (tags) => tags.includes(BackgroundSync.defaultTag)
        );
      }).pipe(Effect.scoped)
    );

    it.live("a push that fails terminally registers the tag", () =>
      Effect.gen(function* () {
        const self = fakeScope();
        const listener = listenOn(self, { offline: Effect.succeed(false) });
        const { engine, failure } = yield* makeEngine(yield* ClientStore.makeMemory, {
          // The sync loop's own debounced push, with no retries: the first
          // failure is terminal and surfaces on `syncFailures`.
          syncLoop: { pushDebounce: "10 millis" },
          retry: { push: Schedule.recurs(0) },
        });
        yield* listener.serve(engine);
        yield* engine.runSync;
        // Let the loop's forked triggers subscribe before the first write.
        yield* Effect.sleep("30 millis");

        // The network looks up, but the backend is unreachable.
        yield* Ref.set(failure, "transport");
        // Keep writing until the debounced push has run and failed (the
        // loop's trigger subscribes on a fiber of its own). Every write is
        // online, so only the failure can register.
        yield* eventually(
          engine
            .mutate("todo/set", { id: "1", title: "stuck" })
            .pipe(Effect.andThen(Effect.sync(() => self.tags))),
          (tags) => tags.includes(BackgroundSync.defaultTag)
        );
      }).pipe(Effect.scoped)
    );

    it.live(
      "a terminal push failure with an immediately-firing SyncManager registers once and fires once: no loop",
      () =>
        Effect.gen(function* () {
          // Online, the registration fires `sync` at once; its flush pushes
          // directly (not through the sync loop), so its own failure rejects
          // the event for the browser to reschedule and never re-registers.
          const self = fakeScope({ firesOnRegister: true });
          const listener = listenOn(self, { offline: Effect.succeed(false) });
          const { engine, store, pushes, failure } = yield* makeEngine(
            yield* ClientStore.makeMemory,
            { syncLoop: { pushDebounce: "50 millis" }, retry: { push: Schedule.recurs(0) } }
          );
          yield* listener.serve(engine);
          yield* engine.runSync;
          // Warm up: a write the loop drains proves its trigger is subscribed.
          yield* eventually(
            engine
              .mutate("todo/set", { id: "0", title: "warm-up" })
              .pipe(Effect.andThen(Effect.sleep("200 millis")), Effect.andThen(Ref.get(pushes))),
            (sent) => Arr.isReadonlyArrayNonEmpty(sent)
          );
          yield* eventually(store.pendingMutations, (pending) => Arr.isReadonlyArrayEmpty(pending));
          expect(self.tags).toEqual([]);

          // One write; the backend is unreachable.
          yield* Ref.set(failure, "transport");
          yield* engine.mutate("todo/set", { id: "1", title: "stuck" });
          yield* eventually(
            Effect.sync(() => self.fired.length),
            (fired) => fired > 0
          );
          const flushed = yield* settle(self.fired[0]);
          expect(flushed.ok).toBe(false);
          // Give any loop time to show itself.
          yield* Effect.sleep("300 millis");
          expect(self.tags).toEqual([BackgroundSync.defaultTag]);
          expect(self.fired).toHaveLength(1);
          expect(yield* store.pendingMutations).toHaveLength(1);
        }).pipe(Effect.scoped),
      30_000
    );

    it.live("by default, a mutation journaled while navigator.onLine is false registers", () =>
      Effect.gen(function* () {
        // No `offline` option: the default reads `navigator.onLine`, which
        // the worker's `WorkerNavigator` carries. Stubbed for the test.
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Object.defineProperty(globalThis.navigator, "onLine", {
              configurable: true,
              get: () => false,
            })
          ),
          () =>
            Effect.sync(() => {
              delete (globalThis.navigator as { onLine?: boolean }).onLine;
            })
        );
        const self = fakeScope();
        const listener = listenOn(self);
        const { engine } = yield* makeEngine(yield* ClientStore.makeMemory);
        yield* listener.serve(engine);
        yield* engine.mutate("todo/set", { id: "1", title: "offline" });
        yield* eventually(
          Effect.sync(() => self.tags),
          (tags) => tags.includes(BackgroundSync.defaultTag)
        );
      }).pipe(Effect.scoped)
    );

    it.live("registerOnJournal: false never registers, even offline", () =>
      Effect.gen(function* () {
        const self = fakeScope();
        const listener = listenOn(self, {
          offline: Effect.succeed(true),
          registerOnJournal: false,
        });
        const { engine } = yield* makeEngine(yield* ClientStore.makeMemory);
        yield* listener.serve(engine);
        yield* engine.mutate("todo/set", { id: "1", title: "offline" });
        yield* Effect.sleep("50 millis");
        expect(self.tags).toEqual([]);
      }).pipe(Effect.scoped)
    );
  });

  describe("the identity boundary (#212)", () => {
    it.live("a sync event does not push a quarantined journal", () =>
      Effect.gen(function* () {
        const self = fakeScope();
        // Bob is who the app says is signed in now.
        const listener = listenOn(self, { identity: Effect.succeed(BOB) });
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
        const listener = listenOn(self, { identity: Ref.get(current) });
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

    it.live("an anonymous replica is not flushed under a sign-in, and is under anonymous", () =>
      Effect.gen(function* () {
        // Anonymous → signed in is the one benign transition, but a
        // context with no UI does not apply it: the page boot does.
        const current = yield* Ref.make<Identity.Fingerprint | undefined>(ALICE);
        const self = fakeScope();
        const listener = listenOn(self, { identity: Ref.get(current) });
        const store = yield* ClientStore.makeKeyValue({ identity: Identity.anonymous });
        const { engine, pushes } = yield* makeEngine(store);
        yield* listener.serve(engine);
        yield* engine.mutate("todo/set", { id: "1", title: "an anonymous write" });

        const skipped = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(skipped).toEqual({ ok: true, value: "IdentityChanged" });
        expect(yield* Ref.get(pushes)).toEqual([]);
        expect(yield* store.pendingMutations).toHaveLength(1);

        yield* Ref.set(current, Identity.anonymous);
        const flushed = yield* settle(self.dispatch(BackgroundSync.defaultTag).held[0]);
        expect(flushed).toEqual({ ok: true, value: "Flushed" });
        expect(yield* Ref.get(pushes)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
    );
  });
});
