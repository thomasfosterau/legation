/**
 * Sign-out resets the durable replica (#219 §4, over #212's identity
 * boundary). The pending-journal ordering decided here: **quarantine** — on a
 * sign-out or an account switch the superseded user's unpushed writes are
 * neither flushed (they would go out under whatever credentials the transport
 * now carries) nor discarded (they are the user's data); they are parked under
 * that user's fingerprint and become pushable again only if they sign back in.
 */
import { describe, expect, it } from "@effect/vitest";
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
  it.effect("is a stable hash of the user, never the id itself", () =>
    Effect.gen(function* () {
      const a = yield* SignOut.fingerprintOf("user-alice");
      expect(a).toBe(yield* SignOut.fingerprintOf("user-alice"));
      expect(a).not.toBe(yield* SignOut.fingerprintOf("user-bob"));
      expect(a).toMatch(/^legation-auth:sha256:[0-9a-f]{64}$/);
      expect(a).not.toContain("alice");
      expect(a.startsWith("@legation/")).toBe(false);
    }).pipe(Effect.provide(testLayer))
  );
});

describe("SignOut.onSessionChange", () => {
  it.effect("sign-out resets the replica and quarantines the pending journal", () =>
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
    ).pipe(Effect.provide(testLayer))
  );

  it.effect("an account switch resets too, and never hands A's journal to B", () =>
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
    ).pipe(Effect.provide(testLayer))
  );

  it.effect("signing back in releases the user's own quarantine", () =>
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
    ).pipe(Effect.provide(testLayer))
  );

  it.effect("the same user is unchanged, and the stamp, not `previous`, decides", () =>
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
    ).pipe(Effect.provide(testLayer))
  );

  it.effect("takes the app's own fingerprint when it is given one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* clientFor(Identity.anonymous);
        const onChange = SignOut.onSessionChange(client, {
          fingerprint: Option.some((subject) => Effect.succeed(`app:${subject.user.id.length}`)),
        });
        expect((yield* onChange(Option.none(), Option.some(alice))).transition).toBe("Upgrade");
        expect(yield* client.identity).toBe("app:10");
      })
    ).pipe(Effect.provide(testLayer))
  );
});
