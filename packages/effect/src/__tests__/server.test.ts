/**
 * The Server facade (ADR-0022, program step 7): one object built over the
 * backend and auth seams — the protocol handler plus `broadcast`, the
 * single verb for out-of-band changes. The test tells ADR-0019's story end
 * to end: a write that bypasses the push path is invisible to a synced
 * Client until `broadcast` pokes its group and the pull picks it up.
 *
 * Both cases run under `it.effect`: every wait advances the `TestClock`, so
 * the debounced auto-push fires when a case moves time past it, and nothing
 * waits on wall-clock time a loaded machine could exhaust (#285).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  Authorization,
  Client,
  ClientStore,
  MemoryBackend,
  Mutator,
  Node,
  Server,
  Transport,
} from "../index.js";
import { InvalidationBus } from "../internal.js";
import { defined } from "./defined.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String },
  edges: {},
});
const nodes = Node.registry([Product]);

const productSet = Mutator.make("product/set", Schema.Unknown);
const mutations = Mutator.registry([
  {
    mutator: productSet,
    local: (args, writer) => writer.put("products", (args as { id: string }).id, args),
  },
]);

// Advance the TestClock 1 ms at a time until the condition holds. Each
// `TestClock.adjust` also yields to the Clients' forked fibres, so this both
// lets in-flight work (a connect push + pull, a poke-driven pull) finish and
// fires the timers due by then. Time is virtual: the bound is a number of
// steps, not a wall-clock budget, so machine load cannot exhaust it.
const advanceUntil = <A>(read: Effect.Effect<A>, until: (value: A) => boolean, maxSteps = 200) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxSteps; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* TestClock.adjust(Duration.millis(1));
    }
    const value = yield* read;
    if (until(value)) return value;
    return yield* Effect.die(new Error(`advanceUntil: condition never held in ${maxSteps} steps`));
  });

describe("Server", () => {
  it.effect("broadcast is the out-of-band verb: bypassed writes reach clients on it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* MemoryBackend.make(
          MemoryBackend.validatedHandlers([
            MemoryBackend.handler(productSet, (args, writer) =>
              writer.put("products", (args as { id: string }).id, args)
            ),
          ])
        );
        // An out-of-band writer: straight into the backend, no push, no hints.
        const writeBypassingPush = (mutationId: number, args: { id: string; name: string }) =>
          backend
            .applyMutations({ clientGroupId: "out-of-band" }, [
              { clientId: "cron", mutationId, mutator: "product/set", args, createdAt: 0 },
            ])
            .pipe(Effect.orDie);

        // The server's bus, counting the hint batches published on it: the
        // fan-out turns only these into pokes, so an unchanged count proves
        // nothing poked the group (no timing involved).
        const inProcess = yield* InvalidationBus.makeInProcess;
        const hintBatches = yield* Ref.make(0);
        const bus: InvalidationBus.InvalidationBus = {
          ...inProcess,
          publish: (hints) =>
            Ref.update(hintBatches, (n) => n + 1).pipe(Effect.andThen(inProcess.publish(hints))),
        };
        const server = yield* Server.make({
          backend,
          auth: { policy: Authorization.policy({ products: Authorization.allowAll }) },
          bus,
        });

        // A row that predates the Client, so its first pull has something to
        // hydrate.
        yield* writeBypassingPush(1, { id: "p-seed", name: "Seed" });

        // A Client synced through the handler, with no interval pull: only a
        // poke or a (re)connect makes it pull. It starts disconnected so its
        // one connect pull runs after the subscription is registered.
        const store = yield* ClientStore.makeMemory;
        const inMemory = yield* Transport.makeInMemory(server.handler, "group-oob");
        // Counts the pulls that reach the server, so the test can check the
        // Client pulled only when it was told to.
        const pulls = yield* Ref.make(0);
        const transport: typeof inMemory = {
          ...inMemory,
          pull: (request) =>
            Ref.update(pulls, (n) => n + 1).pipe(Effect.andThen(inMemory.pull(request))),
        };
        yield* transport.setStatus("disconnected");
        const client = yield* Client.make({
          nodes,
          mutations,
          clientId: "client-oob",
          clientGroupId: "group-oob",
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, transport)
        );

        const observing = yield* Deferred.make<void>();
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe({ collection: "products" }), (rows) =>
            Ref.set(latest, rows).pipe(Effect.andThen(Deferred.succeed(observing, undefined)))
          ).pipe(Effect.ignore)
        );
        // The first emission comes after the subscription is registered.
        yield* Deferred.await(observing);

        // Connect: the one push + pull hydrates the seed. Once it has
        // arrived the Client is idle: nothing else can make it pull.
        yield* transport.setStatus("connected");
        yield* advanceUntil(Ref.get(latest), (rows) => rows.length === 1);

        yield* writeBypassingPush(2, { id: "p-oob", name: "Dropped by cron" });

        // Invisible: the write published no hint, so nothing poked the
        // group, and the idle Client has nothing else that would pull.
        expect(yield* Ref.get(hintBatches)).toBe(0);
        expect(yield* Ref.get(latest)).toHaveLength(1);

        // The one verb: broadcast → poke → pull → the row arrives.
        yield* server.broadcast({ collection: "products", ids: ["p-oob"] });
        expect(yield* Ref.get(hintBatches)).toBe(1);
        const rows = yield* advanceUntil(Ref.get(latest), (current) => current.length === 2);
        expect(
          Arr.sort(
            rows.map((row) => (row.value as { name: string }).name),
            Order.String
          )
        ).toEqual(["Dropped by cron", "Seed"]);
        // Exactly the connect pull and the one broadcast caused: nothing else
        // could have pulled the bypassed write in early.
        expect(yield* Ref.get(pulls)).toBe(2);
      })
    )
  );

  it.effect("pushed mutations broadcast implicitly (no explicit call anywhere)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* MemoryBackend.make(
          MemoryBackend.validatedHandlers([
            MemoryBackend.handler(productSet, (args, writer) =>
              writer.put("products", (args as { id: string }).id, args)
            ),
          ])
        );
        const server = yield* Server.make({
          backend,
          auth: { policy: Authorization.policy({ products: Authorization.allowAll }) },
        });

        const pushDebounce = Duration.millis(10);

        // A Client synced through the handler, counting the pushes and pulls
        // that reach the server once each has completed, so a count the test
        // reads means that leg's effects are already visible. Neither Client
        // has an interval pull, so only a (re)connect, a poke or (for the
        // writer) the debounced auto-push makes one talk to the server.
        const makeClient = (
          clientId: string,
          group: string,
          options: { readonly autoPush: boolean; readonly connected: boolean }
        ) =>
          Effect.gen(function* () {
            const store = yield* ClientStore.makeMemory;
            const inMemory = yield* Transport.makeInMemory(server.handler, group);
            const pushes = yield* Ref.make(0);
            const pulls = yield* Ref.make(0);
            const transport: typeof inMemory = {
              ...inMemory,
              push: (request) =>
                inMemory.push(request).pipe(Effect.tap(() => Ref.update(pushes, (n) => n + 1))),
              pull: (request) =>
                inMemory.pull(request).pipe(Effect.tap(() => Ref.update(pulls, (n) => n + 1))),
            };
            if (!options.connected) yield* transport.setStatus("disconnected");
            const client = yield* Client.make({
              nodes,
              mutations,
              clientId,
              clientGroupId: group,
              ...(options.autoPush ? { syncLoop: { pushDebounce } } : {}),
            }).pipe(
              Effect.provideService(ClientStore.ClientStore, store),
              Effect.provideService(Transport.ClientTransport, transport)
            );
            return { client, transport, pushes, pulls };
          });

        // The writer starts connected: its sync loop's connect leg finds an
        // empty journal (no push) and pulls once.
        const writer = yield* makeClient("client-a", "group-a", {
          autoPush: true,
          connected: true,
        });
        // The reader starts disconnected, so its one connect pull runs after
        // its subscription is registered and registers it with the server.
        const reader = yield* makeClient("client-b", "group-b", {
          autoPush: false,
          connected: false,
        });

        const observing = yield* Deferred.make<void>();
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(reader.client.observe({ collection: "products" }), (rows) =>
            Ref.set(latest, rows).pipe(Effect.andThen(Deferred.succeed(observing, undefined)))
          ).pipe(Effect.ignore)
        );
        // The first emission comes after the subscription is registered.
        yield* Deferred.await(observing);

        // Connect the reader, then wait until both connect legs are done.
        // From here both Clients are idle: the writer's journal is empty and
        // nothing but a poke can make the reader pull.
        yield* reader.transport.setStatus("connected");
        yield* advanceUntil(
          Effect.all([Ref.get(writer.pulls), Ref.get(reader.pulls)]),
          ([writerPulls, readerPulls]) => writerPulls >= 1 && readerPulls >= 1
        );
        expect(yield* Ref.get(writer.pushes)).toBe(0);
        expect(yield* Ref.get(reader.pulls)).toBe(1);
        expect(yield* Ref.get(latest)).toEqual([]);

        // The writer journals a mutation; no app code pushes it. Its connect
        // leg has already run, and its debounce fibre has had every scheduler
        // turn since the writer was built to subscribe to the push trigger
        // (#317), so only the debounced auto-push can send the mutation:
        // nothing reaches the server inside the debounce window, and the
        // push lands the moment the window closes.
        yield* writer.client.mutate("product/set", { id: "p-1", name: "Pushed" });
        yield* TestClock.adjust(Duration.subtract(pushDebounce, Duration.millis(1)));
        expect(yield* Ref.get(writer.pushes)).toBe(0);
        yield* TestClock.adjust(Duration.millis(1));
        expect(yield* Ref.get(writer.pushes)).toBe(1);

        // The push path's hints poke the reader's group across the server's
        // bus (no broadcast call anywhere), and the poke's pull brings the
        // row in.
        const rows = yield* advanceUntil(Ref.get(latest), (current) => current.length === 1);
        expect((defined(rows[0]).value as { name: string }).name).toBe("Pushed");
        // The connect pull and the one the push's poke caused: no other pull
        // could have brought the row in.
        expect(yield* Ref.get(reader.pulls)).toBe(2);
      })
    )
  );
});
