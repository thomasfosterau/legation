/**
 * Pull serialisation (#412): one pull is in flight per engine, and a pull waits only for a pull
 * that starts after it was asked for. Two responses can then never be applied out of order, so an
 * older response cannot revert rows or the cookie.
 *
 * The fake transport holds every response until the test releases it, so each interleaving is
 * staged with Deferreds and no wall-clock time. `settle` yields a fixed number of times to let
 * runnable fibres reach a stop: under the fix a queued pull cannot reach the transport however
 * long it runs, and on trunk a second pull reaches it within a few yields.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Ref, Scope, Stream } from "effect";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Mutator from "../Mutator.js";
import type { Poke, PullRequest, PullResponse } from "../Protocol.js";
import * as Subset from "../Subset.js";
import { ClientTransport, type ClientTransport as ClientTransportShape } from "../Transport.js";

/** Pulls the fake transport will serve; a test that issues more than this fails loudly. */
const PULLS = 3;

const allTodos = Subset.make({ collection: "todos" });

const settle = Effect.forEach(Array.from({ length: 300 }), () => Effect.yieldNow, {
  discard: true,
});

const todoPatch = (title: string) => [
  {
    _tag: "Put" as const,
    collection: "todos",
    id: "t1",
    version: 1,
    value: { id: "t1", title, done: false },
  },
];

const respond = (cookie: string, title: string): PullResponse => ({
  cookie,
  patch: todoPatch(title),
  lastMutationIds: {},
});

interface GatedTransport {
  readonly transport: ClientTransportShape;
  readonly pokes: Queue.Queue<Poke>;
  /** Resolved with the request when the n-th pull reaches the transport. */
  readonly issued: ReadonlyArray<Deferred.Deferred<PullRequest>>;
  /** Resolve the n-th pull's response to release it. */
  readonly answers: ReadonlyArray<Deferred.Deferred<PullResponse>>;
  /** Pulls that have reached the transport so far. */
  readonly count: Effect.Effect<number>;
}

const makeGatedTransport: Effect.Effect<GatedTransport> = Effect.gen(function* () {
  const issued = yield* Effect.all(
    Array.from({ length: PULLS }, () => Deferred.make<PullRequest>())
  );
  const answers = yield* Effect.all(
    Array.from({ length: PULLS }, () => Deferred.make<PullResponse>())
  );
  const pokes = yield* Queue.unbounded<Poke>();
  const calls = yield* Ref.make(0);
  const pull = (request: PullRequest) =>
    Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(calls, (n) => n + 1);
      const signal = issued[index];
      const answer = answers[index];
      if (signal === undefined || answer === undefined) {
        return yield* Effect.die(new Error(`unexpected pull #${index}`));
      }
      yield* Deferred.succeed(signal, request);
      return yield* Deferred.await(answer);
    });
  const transport: ClientTransportShape = {
    push: () => Effect.die(new Error("push is not part of this test")),
    pull,
    pokes: Stream.fromQueue(pokes),
    status: Effect.succeed("disconnected"),
    statusChanges: Stream.never,
  };
  return { transport, pokes, issued, answers, count: Ref.get(calls) };
});

interface Client {
  readonly engine: ClientEngineModule.ClientEngine;
  readonly store: ClientStoreModule.ClientStore;
  readonly gated: GatedTransport;
}

const makeClient: Effect.Effect<Client, never, Scope.Scope> = Effect.gen(function* () {
  const gated = yield* makeGatedTransport;
  const store = yield* ClientStoreModule.makeMemory;
  const engine = yield* ClientEngineModule.make({
    clientId: "client-412",
    clientGroupId: "group-412",
    mutators: Mutator.registry([]),
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, gated.transport)
  );
  return { engine, store, gated };
});

/** The cookie the store holds and the titles the engine shows, read together. */
const snapshot = (client: Client) =>
  Effect.gen(function* () {
    const cookie = yield* client.store.getCookie;
    const rows = yield* client.engine.query(allTodos);
    return { cookie, titles: rows.map((row) => (row.value as { readonly title: string }).title) };
  });

describe("pull serialisation (#412)", () => {
  it.effect(
    "a second pull is not issued while the first is in flight, and rows and cookie never revert",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { issued, answers, count } = client.gated;

        const first = yield* Effect.forkChild(client.engine.pull);
        yield* Deferred.await(issued[0]!);
        const second = yield* Effect.forkChild(client.engine.pull);
        yield* settle;
        // Both pulls would leave with the same cookie if the second one were not held back.
        expect(yield* count).toBe(1);

        yield* Deferred.succeed(answers[0]!, respond("c1", "old"));
        yield* Fiber.join(first);
        expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["old"] });

        // The second pull starts only now, from the cookie the first one applied.
        const secondRequest = yield* Deferred.await(issued[1]!);
        expect(secondRequest.cookie).toBe("c1");
        yield* Deferred.succeed(answers[1]!, respond("c2", "new"));
        yield* Fiber.join(second);
        expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
      })
  );

  it.effect(
    "an explicit pull issued during a poke-triggered pull resolves only after a later pull is applied",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { issued, answers, count, pokes } = client.gated;
        const explicitDone = yield* Ref.make(false);

        yield* client.engine.runSync;
        yield* Queue.offer(pokes, { reason: "test" });
        yield* Deferred.await(issued[0]!);

        const explicit = yield* Effect.forkChild(
          client.engine.pull.pipe(Effect.andThen(Ref.set(explicitDone, true)))
        );
        yield* settle;
        expect(yield* count).toBe(1);

        // The poke's pull lands; the explicit call still needs a pull of its own.
        yield* Deferred.succeed(answers[0]!, respond("c1", "old"));
        yield* settle;
        expect(yield* Ref.get(explicitDone)).toBe(false);
        expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["old"] });

        const explicitRequest = yield* Deferred.await(issued[1]!);
        expect(explicitRequest.cookie).toBe("c1");
        yield* Deferred.succeed(answers[1]!, respond("c2", "new"));
        yield* Fiber.join(explicit);
        expect(yield* Ref.get(explicitDone)).toBe(true);
        expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
      })
  );

  it.effect("pokes that arrive during one pull coalesce into a single follow-up pull", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { issued, answers, count, pokes } = client.gated;

      yield* client.engine.runSync;
      yield* Queue.offer(pokes, { reason: "first" });
      yield* Deferred.await(issued[0]!);

      yield* Queue.offer(pokes, { reason: "second" });
      yield* Queue.offer(pokes, { reason: "third" });
      yield* Queue.offer(pokes, { reason: "fourth" });
      yield* settle;
      expect(yield* count).toBe(1);

      yield* Deferred.succeed(answers[0]!, respond("c1", "old"));
      yield* Deferred.await(issued[1]!);
      yield* Deferred.succeed(answers[1]!, respond("c2", "new"));
      yield* settle;
      // The three pokes shared one follow-up; no pull was left over for them after it.
      expect(yield* count).toBe(2);
      expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
    })
  );
});
