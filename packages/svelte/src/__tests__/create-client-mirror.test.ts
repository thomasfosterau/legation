/**
 * `createClient` over a hosted engine (#146, #147): given a `channel`, the
 * handle's Client is a mirror of the host's engine, and the page's snapshot is
 * offered to the host's store before anything is subscribed. The host owns
 * the empty-store gate: the first offer to an empty host hydrates it, a later
 * one is answered `NotEmpty`, and a handle with no host to answer settles on
 * `None` and still boots. The tests run on the live clock: the handle's
 * runtime and the mirror's waits are real time.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { Client, ClientStore, type Hydration, Transport } from "@thomasfosterau/legation";
import { ClientEngine, EngineHost, MirrorChannel } from "@thomasfosterau/legation/internal";
import { type ClientHandle, type ConnectedClientHandle, createClient } from "../index.svelte.js";
import { mutators, nodes } from "./world.js";

const allTodos = { collection: "todos" };

const snapshotOf = (cookie: string, ids: ReadonlyArray<string>): Hydration.Snapshot => ({
  rows: ids.map((id) => ({
    collection: "todos",
    id,
    version: 1,
    value: { id, title: `todo ${id}` },
  })),
  cookie,
  journal: [],
});

/** An engine host over an empty memory store, offline (it never pulls), and the mirror side of its channel. */
const startHost = Effect.fn("startHost")(function* () {
  const store = yield* ClientStore.makeMemory;
  const engine = yield* ClientEngine.make({
    clientId: "host",
    clientGroupId: "group-1",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, Transport.offline)
  );
  const pair = yield* MirrorChannel.makeLoopbackPair;
  yield* EngineHost.run({ channel: pair.host, engine, store });
  return { store, channel: pair.mirror };
});

/**
 * Build the handle's Client (it is built on first use), disposing the handle's
 * runtime with the test's scope, and return the Client.
 */
const boot = (handle: ClientHandle) =>
  Effect.acquireRelease(handle.runtime.contextEffect, () => handle.runtime.disposeEffect).pipe(
    Effect.map((context) => Context.get(context, Client.Client))
  );

/** The host's answer to the handle's snapshot. */
const hydrationOf = (handle: ConnectedClientHandle) =>
  Effect.tryPromise(() => handle.hydration).pipe(Effect.orDie);

/** The ids the Client reads for all todos, once there are `count` of them. */
const idsOnce = (client: Client.Client, count: number) =>
  client.query(allTodos).pipe(
    Effect.map((rows) => rows.map((row) => row.id)),
    Effect.filterOrFail((ids) => ids.length === count),
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }),
    Effect.orDie
  );

describe("createClient over a hosted engine (#146)", () => {
  it.live(
    "hands the snapshot to an empty host, which hydrates once; a later snapshot is NotEmpty",
    () =>
      Effect.gen(function* () {
        const { store, channel } = yield* startHost();
        const first = createClient({
          nodes,
          mutations: mutators,
          channel,
          snapshot: snapshotOf("server-cookie", ["1", "2"]),
          subscribe: [allTodos],
        });
        const client = yield* boot(first);
        expect(yield* hydrationOf(first)).toEqual(Option.some({ hydrated: true }));
        expect(yield* store.getCookie).toBe("server-cookie");
        // The Client reads the host's rows through the mirror.
        expect([...(yield* idsOnce(client, 2))].toSorted()).toEqual(["1", "2"]);

        // Another tab, a different snapshot: the host's store is no longer empty.
        const second = createClient({
          nodes,
          mutations: mutators,
          channel,
          snapshot: snapshotOf("later-cookie", ["3"]),
        });
        yield* boot(second);
        expect(yield* hydrationOf(second)).toEqual(
          Option.some({ hydrated: false, reason: "NotEmpty" })
        );
        expect(yield* store.getCookie).toBe("server-cookie");
        expect((yield* store.listRows("todos")).map((row) => row.id)).toEqual(["1", "2"]);
      })
  );

  it.live("with no host to answer, the handle settles on None and the Client still boots", () =>
    Effect.gen(function* () {
      const pair = yield* MirrorChannel.makeLoopbackPair;
      const handle = createClient({
        nodes,
        mutations: mutators,
        channel: pair.mirror,
        snapshot: snapshotOf("server-cookie", ["1"]),
        hydrateTimeout: "1 second",
      });
      yield* boot(handle);
      expect(yield* hydrationOf(handle)).toEqual(Option.none());
    })
  );

  it.live("without a snapshot, hydration is None and nothing is offered", () =>
    Effect.gen(function* () {
      const { store, channel } = yield* startHost();
      const handle = createClient({ nodes, mutations: mutators, channel });
      yield* boot(handle);
      expect(yield* hydrationOf(handle)).toEqual(Option.none());
      expect(yield* store.getCookie).toBeUndefined();
    })
  );
});
