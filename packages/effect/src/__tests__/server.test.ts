/**
 * The Server facade (ADR-0022, program step 7): one object built over the
 * backend and auth seams — the protocol handler plus `broadcast`, the
 * single verb for out-of-band changes. The test tells ADR-0019's story end
 * to end: a write that bypasses the push path is invisible to a synced
 * Client until `broadcast` pokes its group and the pull picks it up.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
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

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
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
        const server = yield* Server.make({
          backend,
          auth: { policy: Authorization.policy({ products: Authorization.allowAll }) },
        });

        // A Client synced through the handler; interval pull far away, so
        // only pokes can wake it.
        const store = yield* ClientStore.makeMemory;
        const transport = yield* Transport.makeInMemory(server.handler, "group-oob");
        const client = yield* Client.make({
          nodes,
          mutations,
          clientId: "client-oob",
          clientGroupId: "group-oob",
          syncLoop: { pullInterval: "10 minutes", pushDebounce: "10 millis" },
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, transport)
        );

        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe({ collection: "products" }), (rows) =>
            Ref.set(latest, rows)
          ).pipe(Effect.ignore)
        );
        // Settle the subscription's own hydration first: a pushed marker
        // row proves the round trip is live before the out-of-band write.
        yield* client.mutate("product/set", { id: "p-seed", name: "Seed" });
        yield* eventually(Ref.get(latest), (rows) => rows.length === 1);

        // An out-of-band writer: straight into the backend, no push, no hints.
        yield* backend
          .applyMutations({ clientGroupId: "out-of-band" }, [
            {
              clientId: "cron",
              mutationId: 1,
              mutator: "product/set",
              args: { id: "p-oob", name: "Dropped by cron" },
              createdAt: 0,
            },
          ])
          .pipe(Effect.orDie);

        // Invisible: nothing poked the group, and interval pull is far away.
        yield* sleepReal(200);
        expect(yield* Ref.get(latest)).toHaveLength(1);

        // The one verb: broadcast → poke → pull → the row arrives.
        yield* server.broadcast({ collection: "products", ids: ["p-oob"] });
        const rows = yield* eventually(Ref.get(latest), (current) => current.length === 2);
        expect(rows.map((row) => (row.value as { name: string }).name).sort()).toEqual([
          "Dropped by cron",
          "Seed",
        ]);
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

        const makeClient = (clientId: string, group: string) =>
          Effect.gen(function* () {
            const store = yield* ClientStore.makeMemory;
            const transport = yield* Transport.makeInMemory(server.handler, group);
            return yield* Client.make({
              nodes,
              mutations,
              clientId,
              clientGroupId: group,
              syncLoop: { pullInterval: "10 minutes", pushDebounce: "10 millis" },
            }).pipe(
              Effect.provideService(ClientStore.ClientStore, store),
              Effect.provideService(Transport.ClientTransport, transport)
            );
          });

        const writer = yield* makeClient("client-a", "group-a");
        const reader = yield* makeClient("client-b", "group-b");

        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(reader.observe({ collection: "products" }), (rows) =>
            Ref.set(latest, rows)
          ).pipe(Effect.ignore)
        );
        yield* eventually(Ref.get(latest), () => true);

        // Writer pushes (auto sync loop); the push path's hints poke the
        // reader's group across the same bus — no broadcast call anywhere.
        yield* writer.mutate("product/set", { id: "p-1", name: "Pushed" });
        const rows = yield* eventually(Ref.get(latest), (current) => current.length === 1);
        expect((rows[0]!.value as { name: string }).name).toBe("Pushed");
      })
    )
  );
});
