/**
 * Sign-out resets the durable replica (#219 §4, over #212's identity
 * boundary). The pending-journal ordering decided here: **quarantine** — on a
 * sign-out or an account switch the superseded user's unpushed writes are
 * neither flushed (they would go out under whatever credentials the transport
 * now carries) nor discarded (they are the user's data); they are parked under
 * that user's fingerprint and become pushable again only if they sign back in.
 */
import { assert, describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import { KeyValueStore } from "effect/persistence";
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
} from "@thomasfosterau/legation";
import {
  ClientEngine,
  ClientView,
  Cvr,
  InvalidationBus,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation/internal";
import { createAuthClient } from "@thomasfosterau/effect-auth/client";
import { makeCookieJarFetch, makeServerFixture } from "@thomasfosterau/effect-auth/client/testing";
import { SignOut } from "@thomasfosterau/legation-auth/client";
import type { Protocol } from "@thomasfosterau/legation/internal";

const Note = Node.make("notes", { attributes: { body: Schema.String } });
const nodes = Node.registry([Note]);
const NoteArgs = Schema.Struct({ id: Schema.String, body: Schema.String });
const noteSet = Mutator.make("note/set", NoteArgs);
const mutations = Mutator.registry([
  { mutator: noteSet, local: (args, writer) => writer.put("notes", args.id, args) },
]);

const alice = { user: { id: "user-alice" } };
const bob = { user: { id: "user-bob" } };

/** A sync server and an in-memory transport that records every push it carries. */
const recordingTransport = Effect.fn("recordingTransport")(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(noteSet, (args, writer) => writer.put("notes", args.id, args)),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ notes: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const inner = yield* Transport.makeInMemory(handler, "group-shared");
  const pushes = yield* Ref.make<ReadonlyArray<Protocol.PushRequest>>([]);
  const transport: Transport.ClientTransport = {
    ...inner,
    push: (request) =>
      Ref.update(pushes, (seen) => [...seen, request]).pipe(Effect.andThen(inner.push(request))),
  };
  return { transport, pushes };
});

/** A Client over a durable store stamped with `identity`. */
const clientFor = (identity: Identity.Fingerprint) =>
  Effect.gen(function* () {
    const { transport, pushes } = yield* recordingTransport();
    const store = yield* ClientStore.makeKeyValue({ identity });
    const engine = yield* ClientEngine.make({
      clientId: "client-shared",
      clientGroupId: "group-shared",
      mutators: mutations,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    return { client: Client.fromView(nodes, ClientView.fromEngine(engine)), engine, store, pushes };
  });

const testLayer = Layer.mergeAll(KeyValueStore.layerMemory, Digest.layerWebCrypto);

describe("SignOut.fingerprintOf", () => {
  layer(testLayer)((scoped) => {
    scoped.effect("is a stable hash of the user, never the id itself", () =>
      Effect.gen(function* () {
        const a = yield* SignOut.fingerprintOf("user-alice");
        expect(a).toBe(yield* SignOut.fingerprintOf("user-alice"));
        expect(a).not.toBe(yield* SignOut.fingerprintOf("user-bob"));
        expect(a).toMatch(/^legation-auth:sha256:[0-9a-f]{64}$/);
        expect(a).not.toContain("alice");
        expect(a.startsWith("@legation/")).toBe(false);
      })
    );
  });
});

describe("SignOut.onSessionChange", () => {
  layer(testLayer)((scoped) => {
    scoped.effect("sign-out resets the replica and quarantines the pending journal", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aliceFp = yield* SignOut.fingerprintOf(alice.user.id);
          const { client, engine, store, pushes } = yield* clientFor(aliceFp);
          yield* engine.subscribe(Subset.make({ collection: "notes" }));
          yield* engine.mutate("note/set", { id: "n1", body: "synced" });
          yield* engine.push;
          yield* engine.pull;
          // An unpushed write: the pending journal at sign-out.
          yield* engine.mutate("note/set", { id: "n2", body: "draft" });
          expect(yield* store.listRows("notes")).toHaveLength(1);
          expect(yield* store.pendingMutations).toHaveLength(1);
          const pushedBefore = (yield* Ref.get(pushes)).length;

          const onChange = SignOut.onSessionChange(client);
          const outcome = yield* onChange(Option.some(alice), Option.none());

          expect(outcome.transition).toBe("Reset");
          expect(outcome.quarantinedUnder).toBe(aliceFp);
          expect(outcome.quarantined).toBe(1);
          expect(yield* client.identity).toBe(Identity.anonymous);
          // The durable replica holds nothing of Alice's.
          expect(yield* store.listRows("notes")).toEqual([]);
          expect(yield* store.getCookie).toBeUndefined();
          // Not flushed: the reset pushed nothing.
          expect((yield* Ref.get(pushes)).length).toBe(pushedBefore);
          // Not discarded: quarantined under Alice's fingerprint, out of push's reach.
          expect(yield* store.pendingMutations).toEqual([]);
          expect(yield* client.quarantines).toEqual([aliceFp]);
          expect(yield* client.quarantinedMutations(aliceFp)).toHaveLength(1);
          yield* engine.push;
          expect(
            (yield* Ref.get(pushes)).flatMap((push) => push.mutations).map((m) => m.args)
          ).not.toContainEqual({
            id: "n2",
            body: "draft",
          });
        })
      )
    );
  });

  layer(testLayer)((scoped) => {
    scoped.effect("an account switch resets too, and never hands A's journal to B", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aliceFp = yield* SignOut.fingerprintOf(alice.user.id);
          const { client, engine, store } = yield* clientFor(aliceFp);
          yield* engine.mutate("note/set", { id: "n3", body: "alice's draft" });
          const outcome = yield* SignOut.onSessionChange(client)(
            Option.some(alice),
            Option.some(bob)
          );
          expect(outcome.transition).toBe("Reset");
          expect(yield* client.identity).toBe(yield* SignOut.fingerprintOf(bob.user.id));
          expect(yield* store.pendingMutations).toEqual([]);
          expect(yield* client.quarantinedMutations(aliceFp)).toHaveLength(1);
        })
      )
    );
  });

  layer(testLayer)((scoped) => {
    scoped.effect("signing back in releases the user's own quarantine", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aliceFp = yield* SignOut.fingerprintOf(alice.user.id);
          const { client, engine, store } = yield* clientFor(aliceFp);
          yield* engine.mutate("note/set", { id: "n4", body: "alice's draft" });
          const onChange = SignOut.onSessionChange(client);
          yield* onChange(Option.some(alice), Option.none());
          const back = yield* onChange(Option.none(), Option.some(alice));
          expect(back.transition).toBe("Upgrade");
          expect(back.released).toBe(1);
          expect(yield* store.pendingMutations).toHaveLength(1);
          expect(yield* client.quarantines).toEqual([]);
        })
      )
    );
  });

  layer(testLayer)((scoped) => {
    scoped.effect("the same user is unchanged, and the stamp, not `previous`, decides", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aliceFp = yield* SignOut.fingerprintOf(alice.user.id);
          const { client, store, engine } = yield* clientFor(aliceFp);
          yield* engine.mutate("note/set", { id: "n5", body: "kept" });
          const onChange = SignOut.onSessionChange(client);
          expect((yield* onChange(Option.some(alice), Option.some(alice))).transition).toBe(
            "Unchanged"
          );
          expect(yield* store.pendingMutations).toHaveLength(1);
          // A listener told the wrong `previous` (a missed notification) still resets.
          const missed = yield* onChange(Option.some(bob), Option.some(bob));
          expect(missed.transition).toBe("Reset");
          expect(yield* client.identity).toBe(yield* SignOut.fingerprintOf(bob.user.id));
        })
      )
    );
  });

  layer(testLayer)((scoped) => {
    scoped.effect("takes the app's own fingerprint when it is given one", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* clientFor(Identity.anonymous);
          const onChange = SignOut.onSessionChange(client, {
            fingerprint: (subject) => Effect.succeed(`app:${subject.user.id.length}`),
          });
          expect((yield* onChange(Option.none(), Option.some(alice))).transition).toBe("Upgrade");
          expect(yield* client.identity).toBe("app:10");
        })
      )
    );
  });
});

layer(testLayer)("SignOut.fingerprintOfSession", (it) => {
  it.effect("is anonymous when signed out, and the user's fingerprint when signed in", () =>
    Effect.gen(function* () {
      expect(yield* SignOut.fingerprintOfSession(Option.none())).toBe(Identity.anonymous);
      expect(yield* SignOut.fingerprintOfSession(Option.some(alice))).toBe(
        yield* SignOut.fingerprintOf(alice.user.id)
      );
      expect(
        yield* SignOut.fingerprintOfSession(Option.some(alice), {
          fingerprint: (subject) => Effect.succeed(`app:${subject.user.id}`),
        })
      ).toBe("app:user-alice");
    })
  );
});

/** An effect-auth client over its in-memory server fixture, through a cookie-jar `fetch`. */
const authClient = () =>
  createAuthClient({
    baseUrl: "http://localhost",
    fetch: makeCookieJarFetch(makeServerFixture().handler),
  });

/** A store held in one state, counting its subscribers. */
const heldStore = (state: ReturnType<SignOut.SessionStore["get"]>) => {
  let subscribers = 0;
  const store: SignOut.SessionStore = {
    get: () => state,
    subscribe: () => {
      subscribers += 1;
      return () => {
        subscribers -= 1;
      };
    },
  };
  return { store, subscribers: () => subscribers };
};

/** Run a promise of the auth client's; a rejection is a defect of the test. */
const run = <A>(call: () => Promise<A>) => Effect.orDie(Effect.tryPromise(call));

/** The fingerprint `follow` stamps without a Digest in context: WebCrypto's. */
const webCryptoFingerprint = (userId: string) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(Digest.layerWebCrypto), (context) =>
      Effect.provideContext(SignOut.fingerprintOf(userId), context)
    )
  );

/** The change `settled` reports, or a failed assertion when none was adopted. */
const adopted = (settled: Option.Option<SignOut.SessionChange>): SignOut.SessionChange =>
  Option.getOrElse(settled, () => assert.fail("no session change was adopted"));

layer(KeyValueStore.layerMemory)("SignOut.follow (no Digest in context)", (it) => {
  it.effect("a store change resets the client: sign-in, sign-out, the next user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, engine, store } = yield* clientFor(Identity.anonymous);
        const auth = authClient();
        // No Digest in context: follow hashes with WebCrypto's.
        const following = yield* SignOut.follow(client, auth.session);

        const signedUp = yield* run(() =>
          auth.signUp({ email: "alice@example.com", password: "correct horse battery" })
        );
        const aliceId = signedUp.user?.id ?? "";
        expect(aliceId).not.toBe("");
        expect(adopted(yield* following.settled).transition).toBe("Upgrade");
        const aliceFp = yield* webCryptoFingerprint(aliceId);
        expect(yield* client.identity).toBe(aliceFp);

        yield* engine.subscribe(Subset.make({ collection: "notes" }));
        yield* engine.mutate("note/set", { id: "n6", body: "alice's draft" });

        yield* run(() => auth.signOut());
        const signedOut = adopted(yield* following.settled);
        expect(signedOut.transition).toBe("Reset");
        expect(signedOut.quarantinedUnder).toBe(aliceFp);
        expect(signedOut.quarantined).toBe(1);
        expect(yield* client.identity).toBe(Identity.anonymous);
        expect(yield* store.pendingMutations).toEqual([]);
        expect(yield* store.listRows("notes")).toEqual([]);

        const next = yield* run(() =>
          auth.signUp({ email: "bob@example.com", password: "correct horse battery" })
        );
        expect(adopted(yield* following.settled).transition).toBe("Upgrade");
        expect(yield* client.identity).toBe(yield* webCryptoFingerprint(next.user?.id ?? ""));
        // Bob's replica never sees Alice's journal.
        expect(yield* store.pendingMutations).toEqual([]);
        expect(yield* client.quarantinedMutations(aliceFp)).toHaveLength(1);
      })
    )
  );
});

layer(testLayer)("SignOut.follow", (it) => {
  it.effect("a pending store is not a sign-out", () =>
    Effect.gen(function* () {
      const aliceFp = yield* SignOut.fingerprintOf(alice.user.id);
      const held = heldStore({ data: null, isPending: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* clientFor(aliceFp);
          const following = yield* SignOut.follow(client, held.store);
          expect(held.subscribers()).toBe(1);
          expect(yield* following.settled).toEqual(Option.none());
          expect(yield* client.identity).toBe(aliceFp);
        })
      );
      // Closing the scope unsubscribes.
      expect(held.subscribers()).toBe(0);
    })
  );

  it.effect("adopts the store's settled state when it starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aliceFp = yield* SignOut.fingerprintOf(alice.user.id);
        const { client } = yield* clientFor(aliceFp);
        const held = heldStore({ data: null, isPending: false });
        const following = yield* SignOut.follow(client, held.store);
        expect(adopted(yield* following.settled).transition).toBe("Reset");
        expect(yield* client.identity).toBe(Identity.anonymous);
      })
    )
  );
});
