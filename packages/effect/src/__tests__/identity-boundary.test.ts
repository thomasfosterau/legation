/**
 * The identity boundary (#212).
 *
 * The invariant under test, in the register CONTEXT.md states it: **a durable
 * replica belongs to exactly one resolved identity, and an identity change is
 * a reset, not a rebase.**
 *
 * The scenario these tests exist for: user A syncs private rows legitimately
 * — the server's auth filter said they could have them — signs out, and B
 * signs in on the same device. A's rows are the freshest thing on the machine
 * and nothing else in the engine has a reason to distrust them. So:
 *
 * - B never observes A's rows, in-session or after a reload.
 * - A's unpushed writes are quarantined, never discarded (data loss) and
 *   never pushed under B's session (a forged write). That second property
 *   gets its own test, not incidental coverage by the reset test.
 * - A signing back in makes their own quarantined writes pushable again.
 * - Discarding a quarantine is an explicit call; no reset and no boot does it.
 * - Anonymous → signed in keeps the warm replica: the one permitted upgrade.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Identity,
  MemoryBackend,
  Mutator,
  Node,
  Transport,
} from "../index.js";
import { ClientEngine, ClientView, Cvr, InvalidationBus, Subset, SyncServer } from "../internal.js";
import type { PushRequest } from "../Protocol.js";

const Secret = Node.make("secrets", { attributes: { body: Schema.String } });
const nodes = Node.registry([Secret]);

const secretSet = Mutator.make("secret/set", Schema.Unknown);
const mutations = Mutator.registry([
  {
    mutator: secretSet,
    local: (args, writer) => writer.put("secrets", (args as { id: string }).id, args),
  },
]);

const allSecrets = Subset.make({ collection: "secrets" });

const makeHandler = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(secretSet, (args, writer) =>
        writer.put("secrets", (args as { id: string }).id, args)
      ),
    ])
  );
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ secrets: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
});

/** An in-memory transport that records every push request it carries. */
const recordingTransport = Effect.gen(function* () {
  const handler = yield* makeHandler;
  const inner = yield* Transport.makeInMemory(handler, "group-shared");
  const pushes = yield* Ref.make<ReadonlyArray<PushRequest>>([]);
  const transport: Transport.ClientTransport = {
    ...inner,
    push: (request) =>
      Ref.update(pushes, (seen) => [...seen, request]).pipe(Effect.andThen(inner.push(request))),
  };
  return { transport, pushes };
});

/**
 * An engine over a caller-supplied store, so a test can rebuild one over the
 * same KeyValueStore and model a reload.
 */
const engineOver = (store: ClientStore.ClientStore, transport: Transport.ClientTransport) =>
  ClientEngine.make({
    clientId: "client-shared",
    clientGroupId: "group-shared",
    mutators: mutations,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );

const bodies = (rows: ReadonlyArray<{ readonly value: unknown }>) =>
  rows.map((row) => (row.value as { body: string }).body).toSorted();

const ALICE: Identity.Fingerprint = "sha256:alice-subject-hash";
const BOB: Identity.Fingerprint = "sha256:bob-subject-hash";

describe("Identity.transitionOf", () => {
  it("treats an unstamped replica as belonging to nobody, so adopting resets", () => {
    expect(Identity.transitionOf(Identity.unstamped, ALICE)).toBe("Reset");
    expect(Identity.transitionOf(Identity.unstamped, Identity.anonymous)).toBe("Reset");
  });

  it("permits only the anonymous upgrade; every other change is a reset", () => {
    expect(Identity.transitionOf(Identity.anonymous, ALICE)).toBe("Upgrade");
    expect(Identity.transitionOf(ALICE, BOB)).toBe("Reset");
    // Signing out is a downgrade, not an upgrade: A's private rows must not
    // be served to a public session.
    expect(Identity.transitionOf(ALICE, Identity.anonymous)).toBe("Reset");
    expect(Identity.transitionOf(ALICE, ALICE)).toBe("Unchanged");
  });
});

describe("the store's boot check", () => {
  it.effect("stamps the identity and leaves a matching replica alone", () =>
    Effect.gen(function* () {
      const first = yield* ClientStore.makeKeyValue({ identity: ALICE });
      yield* first.putRow("secrets", { id: "s1", version: 1, value: { body: "alice's" } });
      yield* first.setCookie("cookie-alice");
      expect(yield* first.getIdentity).toBe(ALICE);

      // A reload under the same identity: nothing moves.
      const again = yield* ClientStore.makeKeyValue({ identity: ALICE });
      expect(yield* again.listRows("secrets")).toHaveLength(1);
      expect(yield* again.getCookie).toBe("cookie-alice");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a mismatch drops rows and cookie, and quarantines the journal under the old identity",
    () =>
      Effect.gen(function* () {
        const alice = yield* ClientStore.makeKeyValue({ identity: ALICE });
        yield* alice.putRow("secrets", { id: "s1", version: 1, value: { body: "alice's" } });
        yield* alice.setCookie("cookie-alice");
        yield* alice.appendMutation({
          clientId: "c1",
          mutationId: yield* alice.nextMutationId("c1"),
          mutator: "secret/set",
          args: { id: "s2", body: "alice's draft" },
          createdAt: 0,
        });

        const bob = yield* ClientStore.makeKeyValue({ identity: BOB });
        expect(yield* bob.getIdentity).toBe(BOB);
        expect(yield* bob.listRows("secrets")).toEqual([]);
        expect(yield* bob.getCookie).toBeUndefined();
        // Not discarded — parked under the fingerprint it was authored under,
        // and out of the keyspace `push` reads.
        expect(yield* bob.pendingMutations).toEqual([]);
        expect(yield* bob.quarantines).toEqual([ALICE]);
        expect(yield* bob.quarantinedMutations(ALICE)).toHaveLength(1);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("an unstamped replica resets when the boundary is first turned on", () =>
    Effect.gen(function* () {
      // A store written by a build with no identity boundary: rows that could
      // belong to anyone.
      const legacy = yield* ClientStore.makeKeyValue();
      yield* legacy.putRow("secrets", { id: "s1", version: 1, value: { body: "unknown owner" } });
      yield* legacy.setCookie("cookie-legacy");
      expect(yield* legacy.getIdentity).toBeUndefined();

      const scoped = yield* ClientStore.makeKeyValue({ identity: ALICE });
      expect(yield* scoped.listRows("secrets")).toEqual([]);
      expect(yield* scoped.getCookie).toBeUndefined();
      expect(yield* scoped.getIdentity).toBe(ALICE);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("re-signing in releases that identity's own quarantine back into the journal", () =>
    Effect.gen(function* () {
      const alice = yield* ClientStore.makeKeyValue({ identity: ALICE });
      yield* alice.appendMutation({
        clientId: "c1",
        mutationId: 1,
        mutator: "secret/set",
        args: { id: "s2", body: "alice's draft" },
        createdAt: 0,
      });

      const bob = yield* ClientStore.makeKeyValue({ identity: BOB });
      expect(yield* bob.pendingMutations).toEqual([]);

      const aliceAgain = yield* ClientStore.makeKeyValue({ identity: ALICE });
      expect(yield* aliceAgain.pendingMutations).toHaveLength(1);
      expect(yield* aliceAgain.quarantines).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("no boot ever discards a quarantine", () =>
    Effect.gen(function* () {
      const alice = yield* ClientStore.makeKeyValue({ identity: ALICE });
      yield* alice.appendMutation({
        clientId: "c1",
        mutationId: 1,
        mutator: "secret/set",
        args: { id: "s2", body: "alice's draft" },
        createdAt: 0,
      });
      yield* ClientStore.makeKeyValue({ identity: BOB });

      // Boot after boot after boot: A's intents are still there.
      yield* ClientStore.makeKeyValue({ identity: BOB });
      yield* ClientStore.makeKeyValue({ identity: Identity.anonymous });
      const last = yield* ClientStore.makeKeyValue({ identity: BOB });
      expect(yield* last.quarantinedMutations(ALICE)).toHaveLength(1);

      // Only an explicit discard destroys them.
      yield* last.discardQuarantine(ALICE);
      expect(yield* last.quarantines).toEqual([]);
      expect(yield* last.quarantinedMutations(ALICE)).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("anonymous → signed in keeps the warm replica and its journal", () =>
    Effect.gen(function* () {
      const anon = yield* ClientStore.makeKeyValue({ identity: Identity.anonymous });
      yield* anon.putRow("secrets", { id: "s1", version: 1, value: { body: "public row" } });
      yield* anon.setCookie("cookie-anon");
      yield* anon.appendMutation({
        clientId: "c1",
        mutationId: 1,
        mutator: "secret/set",
        args: { id: "s2", body: "written before signing in" },
        createdAt: 0,
      });

      const signedIn = yield* ClientStore.makeKeyValue({ identity: ALICE });
      expect(yield* signedIn.getIdentity).toBe(ALICE);
      expect(yield* signedIn.listRows("secrets")).toHaveLength(1);
      expect(yield* signedIn.getCookie).toBe("cookie-anon");
      expect(yield* signedIn.pendingMutations).toHaveLength(1);
      expect(yield* signedIn.quarantines).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("switching identities on a shared device", () => {
  it.effect("B's live queries never observe A's rows — in the session and after a reload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { transport } = yield* recordingTransport;

        // A syncs a private row legitimately.
        const aliceStore = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const alice = yield* engineOver(aliceStore, transport);
        yield* alice.subscribe(allSecrets);
        yield* alice.mutate("secret/set", { id: "s1", body: "alice's private row" });
        yield* alice.push;
        yield* alice.pull;
        expect(bodies(yield* alice.query(allSecrets))).toEqual(["alice's private row"]);

        // B signs in on the same device, in the same session.
        const client = Client.fromView(nodes, ClientView.fromEngine(alice));
        yield* client.subscribe({ collection: "secrets" });
        const outcome = yield* client.reset(BOB);
        expect(outcome.transition).toBe("Reset");

        const observed = yield* Stream.runHead(client.observe({ collection: "secrets" }));
        expect(Option.getOrElse(observed, () => ["never emitted"])).toEqual([]);
        // The superseded identity's subscriptions went with its rows: a
        // ledger entry left behind would claim B's reads are covered by a
        // window A registered.
        expect(yield* client.subscriptions).toEqual([]);
        expect(yield* alice.activeSubscriptions).toEqual([]);

        // ...and after a reload: a fresh store + engine over the same
        // durable storage, which is where "the replica is the freshest thing
        // on the device" would otherwise bite.
        const bobStore = yield* ClientStore.makeKeyValue({ identity: BOB });
        const bob = yield* engineOver(bobStore, transport);
        expect(yield* bob.query(allSecrets)).toEqual([]);
        expect(yield* bobStore.listRows("secrets")).toEqual([]);
      })
    ).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("A's quarantined journal entries are never pushed under B's session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { transport, pushes } = yield* recordingTransport;

        const aliceStore = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const alice = yield* engineOver(aliceStore, transport);
        // Authored, never pushed — the journal is durable and causally
        // ordered, so without a boundary these survive the sign-out and go
        // out under the next session's cookies.
        yield* alice.mutate("secret/set", { id: "s1", body: "alice's unsent write" });
        yield* alice.mutate("secret/set", { id: "s2", body: "alice's other unsent write" });
        expect(yield* aliceStore.pendingMutations).toHaveLength(2);

        yield* alice.reset(BOB);

        // B pushes — everything they can. Twice, and after a reload, because
        // "never pushed" has to hold for every push B will ever make.
        yield* alice.push;
        yield* alice.mutate("secret/set", { id: "s3", body: "bob's own write" });
        yield* alice.push;

        const bobStore = yield* ClientStore.makeKeyValue({ identity: BOB });
        const bob = yield* engineOver(bobStore, transport);
        yield* bob.push;

        const sent = (yield* Ref.get(pushes)).flatMap((request) => request.mutations);
        expect(sent.map((m) => (m.args as { body: string }).body)).toEqual(["bob's own write"]);

        // Not discarded either: parked under A's fingerprint, intact.
        expect(yield* bobStore.quarantines).toEqual([ALICE]);
        expect(yield* bobStore.quarantinedMutations(ALICE)).toHaveLength(2);
      })
    ).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("A signing back in makes A's quarantined entries pushable again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { transport, pushes } = yield* recordingTransport;

        const aliceStore = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const alice = yield* engineOver(aliceStore, transport);
        yield* alice.mutate("secret/set", { id: "s1", body: "alice's unsent write" });

        const toBob = yield* alice.reset(BOB);
        expect(toBob).toMatchObject({
          transition: "Reset",
          quarantinedUnder: ALICE,
          quarantined: 1,
        });
        expect(yield* aliceStore.pendingMutations).toEqual([]);

        const backToAlice = yield* alice.reset(ALICE);
        expect(backToAlice).toMatchObject({ transition: "Reset", released: 1 });
        expect(yield* aliceStore.pendingMutations).toHaveLength(1);
        expect(yield* aliceStore.quarantines).toEqual([]);

        yield* alice.push;
        const sent = (yield* Ref.get(pushes)).flatMap((request) => request.mutations);
        expect(sent.map((m) => (m.args as { body: string }).body)).toEqual([
          "alice's unsent write",
        ]);
      })
    ).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a reset never discards a quarantine; only discardQuarantine does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { transport } = yield* recordingTransport;
        const store = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const engine = yield* engineOver(store, transport);
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        yield* client.mutate("secret/set", { id: "s1", body: "alice's unsent write" });
        yield* client.reset(BOB);

        // Reset after reset after reset — A's intents outlive all of them.
        yield* client.reset(Identity.anonymous);
        yield* client.reset(BOB);
        expect(yield* client.quarantines).toEqual([ALICE]);
        expect(yield* client.quarantinedMutations(ALICE)).toHaveLength(1);

        yield* client.discardQuarantine(ALICE);
        expect(yield* client.quarantines).toEqual([]);
      })
    ).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("anonymous → signed in keeps the warm replica, subscriptions and all", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { transport } = yield* recordingTransport;
        const store = yield* ClientStore.makeKeyValue({ identity: Identity.anonymous });
        const engine = yield* engineOver(store, transport);
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        yield* client.subscribe({ collection: "secrets" });
        yield* engine.mutate("secret/set", { id: "s1", body: "public row" });
        yield* engine.push;
        yield* engine.pull;
        expect(bodies(yield* store.listRows("secrets"))).toEqual(["public row"]);
        yield* client.mutate("secret/set", { id: "s2", body: "written before signing in" });

        const outcome = yield* client.reset(ALICE);
        expect(outcome).toMatchObject({ transition: "Upgrade", quarantined: 0 });

        // Nothing was thrown away: rows, cookie, subscriptions and the
        // unpushed journal all survive the first sign-in.
        expect(bodies(yield* store.listRows("secrets"))).toEqual(["public row"]);
        expect(yield* store.getCookie).toBeDefined();
        expect(yield* store.pendingMutations).toHaveLength(1);
        expect(yield* engine.activeSubscriptions).toHaveLength(1);
        expect(yield* store.getIdentity).toBe(ALICE);
      })
    ).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("Client.make adopts the identity before the replica can answer a read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { transport } = yield* recordingTransport;
        const aliceStore = yield* ClientStore.makeKeyValue({ identity: ALICE });
        const alice = yield* engineOver(aliceStore, transport);
        yield* alice.subscribe(allSecrets);
        yield* alice.mutate("secret/set", { id: "s1", body: "alice's private row" });
        yield* alice.push;
        yield* alice.pull;

        // B's Client is built over the very same durable store, with the
        // boundary named only on the Client — the store itself is opened
        // without an `identity`, so this is `Client.make`'s adoption doing
        // the work.
        const store = yield* ClientStore.makeKeyValue();
        expect(yield* store.listRows("secrets")).toHaveLength(1);

        const client = yield* Client.make({
          nodes,
          mutations,
          store,
          transport,
          clientId: "client-shared",
          clientGroupId: "group-shared",
          identity: BOB,
          sync: false,
        });
        // `observe` is the replica-backed tier and never falls through, so
        // this is a statement about the replica, not about what the server
        // would answer.
        const observed = yield* Stream.runHead(client.observe({ collection: "secrets" }));
        expect(Option.getOrElse(observed, () => ["never emitted"])).toEqual([]);
        expect(yield* store.listRows("secrets")).toEqual([]);
        expect(yield* client.identity).toBe(BOB);
      })
    ).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a connected Client says the host owns the replica rather than faking a reset", () =>
    Effect.gen(function* () {
      // A view with no identity boundary stands in for a mirror, which holds
      // no durable state of its own.
      const engine = yield* engineOver(
        yield* ClientStore.makeMemory,
        (yield* recordingTransport).transport
      );
      const { identityBoundary: _omitted, ...mirrorLike } = ClientView.fromEngine(engine);
      const client = Client.fromView(nodes, mirrorLike);
      const error = yield* Effect.flip(client.reset(BOB));
      expect(error._tag).toBe("StoreError");
      expect(error.message).toContain("hosted elsewhere");
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );
});
