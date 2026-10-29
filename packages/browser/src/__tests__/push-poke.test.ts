/**
 * Web Push as a poke carrier, the worker side (#214): a fake `self` dispatches
 * `push` events to `PushPoke.listen`. A push with the library's marker
 * registers the Background Sync tag (the default) or pulls (`action: "pull"`),
 * once the replica's identity checks out; every other push is left to the
 * app's own handler. The engine is a real one over an in-memory transport and
 * `SyncServer`, so a pull is a real pull.
 */
import {
  Authorization,
  Backend,
  ClientStore,
  type Identity,
  MemoryBackend,
  Mutator,
  Transport,
} from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  Cvr,
  InvalidationBus,
  PushPoke as Marker,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as BackgroundSync from "../BackgroundSync.js";
import * as PushPoke from "../PushPoke.js";

const ALICE: Identity.Fingerprint = "sha256:alice-subject-hash";
const BOB: Identity.Fingerprint = "sha256:bob-subject-hash";

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Struct({ id: Schema.String })),
    local: () => Effect.void,
  },
]);

/** A stand-in for `self`: `push` listener slots, and a `SyncManager` that records each tag. */
const fakeScope = () => {
  const listeners: Array<(event: PushPoke.PushEvent) => void> = [];
  const tags: Array<string> = [];
  const sync: BackgroundSync.SyncManager = {
    register: (tag) => Promise.resolve(void tags.push(tag)),
  };
  const scope: PushPoke.PushScope = {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    registration: { sync },
  };
  /** Dispatch a push with `text` as its data; return what the listeners held. */
  const push = (text?: string): Array<Promise<unknown>> => {
    const held: Array<Promise<unknown>> = [];
    const event: PushPoke.PushEvent = {
      data: text === undefined ? null : { text: () => text },
      waitUntil: (promise) => {
        held.push(promise);
      },
    };
    Arr.forEach(listeners, (listener) => {
      listener(event);
    });
    return held;
  };
  return { scope, tags, push };
};

const makeEngine = (stamp: Identity.Fingerprint) =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make({});
    const handler = yield* SyncServer.make.pipe(
      Effect.provideService(Backend.Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
    const transport = yield* Transport.makeInMemory(handler, "group-push");
    const engine = yield* ClientEngine.make({
      clientId: "client-push",
      clientGroupId: "group-push",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, yield* ClientStore.makeMemory),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    yield* engine.reset(stamp);
    return engine;
  });

const outcome = (held: Array<Promise<unknown>>) =>
  Effect.tryPromise(() => held[0] ?? Promise.resolve("nothing held")).pipe(Effect.orDie);

describe("PushPoke.listen (#214)", () => {
  it.effect("registers the Background Sync tag for the library's push, by default", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = PushPoke.listen({ identity: Effect.succeed(ALICE), scope: self.scope });
      yield* listener.serve(yield* makeEngine(ALICE));
      expect(yield* outcome(self.push(Marker.payload))).toBe("Registered");
      expect(self.tags).toEqual(["legation-flush"]);
    })
  );

  it.effect("pulls instead when the app opts in", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const engine = yield* makeEngine(ALICE);
      const listener = PushPoke.listen({
        identity: Effect.succeed(ALICE),
        action: "pull",
        scope: self.scope,
      });
      yield* listener.serve(engine);
      const before = yield* engine.pullCounts;
      expect(yield* outcome(self.push(Marker.payload))).toBe("Pulled");
      expect((yield* engine.pullCounts).applied).toBe(before.applied + 1);
      expect(self.tags).toEqual([]);
    })
  );

  it.effect("leaves any other push to the app's own handler", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = PushPoke.listen({ identity: Effect.succeed(ALICE), scope: self.scope });
      yield* listener.serve(yield* makeEngine(ALICE));
      expect(self.push('{"title":"A notification of the app\'s own"}')).toEqual([]);
      expect(self.push()).toEqual([]);
      expect(self.tags).toEqual([]);
    })
  );

  it.effect("does nothing for a push whose replica belongs to another identity", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const engine = yield* makeEngine(ALICE);
      // Bob is signed in now; the replica is still stamped for Alice.
      const listener = PushPoke.listen({
        identity: Effect.succeed(BOB),
        action: "pull",
        scope: self.scope,
      });
      yield* listener.serve(engine);
      const before = yield* engine.pullCounts;
      expect(yield* outcome(self.push(Marker.payload))).toBe("IdentityChanged");
      expect((yield* engine.pullCounts).started).toBe(before.started);
    })
  );

  it.effect("waits for a host that attaches after the push arrived", () =>
    Effect.gen(function* () {
      const self = fakeScope();
      const listener = PushPoke.listen({ identity: Effect.succeed(ALICE), scope: self.scope });
      const held = self.push(Marker.payload);
      yield* listener.serve(yield* makeEngine(ALICE));
      expect(yield* outcome(held)).toBe("Registered");
    })
  );
});
