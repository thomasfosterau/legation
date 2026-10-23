/**
 * `Server.mutate` (ADR-0030, amendment #215 §1–§3): a form action runs one
 * named Mutation as one of a client group's mutations, under a **form client**
 * id minted for the rendered form, and answers a receipt with the backend's
 * ruling. It is the push path minus the transport, so identity, middleware,
 * the mutation-id ledger and the broadcast all apply as they do to a push.
 *
 * The SqlBackend half of "works over both backends" is in
 * `packages/sql/src/__tests__/backend-contract.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Authorization,
  MemoryBackend,
  MutationRejected,
  Mutator,
  Server,
  type Backend,
} from "../index.js";
import { Subset } from "../internal.js";

// A counter bump: applying it twice would show as `n: 2`.
const bump = Mutator.make("counter/bump", Schema.Struct({ id: Schema.String }));
// A Mutation the backend always rejects, after staging a write it must discard.
const refuse = Mutator.make("counter/refuse", Schema.Struct({ id: Schema.String }));
// A Mutation whose args are refined: an empty id is the wrong shape to hand over.
const named = Mutator.make("counter/named", Schema.Struct({ id: Schema.NonEmptyString }));
// A Mutation whose args carry a transformation, so encoding is observable.
const stamp = Mutator.make(
  "counter/stamp",
  Schema.Struct({ id: Schema.String, at: Schema.NumberFromString })
);

// `seen` records the identity each bump's handler ran under.
const makeBackendSeeing = (seen: Ref.Ref<ReadonlyArray<unknown>>) =>
  MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(bump, (args, writer, context) =>
        Effect.gen(function* () {
          yield* Ref.update(seen, (all) => [...all, context.identity]);
          const current = yield* writer.get("counters", args.id);
          const n = P.hasProperty(current, "n") && P.isNumber(current.n) ? current.n : 0;
          yield* writer.put("counters", args.id, { id: args.id, n: n + 1 });
        })
      ),
      MemoryBackend.handler(refuse, (args, writer) =>
        writer
          .put("counters", args.id, { id: args.id, n: -1 })
          .pipe(Effect.andThen(Effect.fail(new MutationRejected({ reason: "sold out" }))))
      ),
      MemoryBackend.handler(stamp, (args, writer) =>
        writer.put("counters", args.id, { id: args.id, n: args.at })
      ),
    ])
  );

const makeBackend = Ref.make<ReadonlyArray<unknown>>([]).pipe(Effect.flatMap(makeBackendSeeing));

const policy = Authorization.policy({ counters: Authorization.allowAll });

const rowsOf = (backend: Backend.Backend, clientGroupId: string, id: string) =>
  backend.getRows({ clientGroupId }, "counters", [id]).pipe(Effect.orDie);

describe("Server.mutate", () => {
  it.effect("the same form submitted twice applies once, and both answer one receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeBackend;
        const server = yield* Server.make({ backend, auth: { policy } });
        const submission = {
          clientGroupId: "group-1",
          clientId: "form-a",
          mutationId: 1,
          mutation: bump,
          args: { id: "c1" },
        } as const;

        const first = yield* server.mutate(submission);
        const second = yield* server.mutate(submission);

        expect(first).toEqual({ clientId: "form-a", mutationId: 1, phase: "acknowledged" });
        expect(second).toEqual(first);
        const rows = yield* rowsOf(backend, "group-1", "c1");
        expect(rows.map((row) => row.value)).toEqual([{ id: "c1", n: 1 }]);
      })
    )
  );

  it.effect("a permanent rejection answers its reason and bumps the id without effects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeBackend;
        const server = yield* Server.make({ backend, auth: { policy } });
        const submission = {
          clientGroupId: "group-1",
          clientId: "form-b",
          mutationId: 1,
          mutation: refuse,
          args: { id: "c2" },
        } as const;

        const receipt = yield* server.mutate(submission);
        expect(receipt).toEqual({
          clientId: "form-b",
          mutationId: 1,
          phase: "rejected",
          reason: "sold out",
        });
        expect(yield* rowsOf(backend, "group-1", "c2")).toEqual([]);
        const ledger = yield* backend
          .lastMutationIds({ clientGroupId: "group-1" })
          .pipe(Effect.orDie);
        expect(ledger["form-b"]).toBe(1);

        // A resubmission answers the remembered ruling (Backend guarantee 4).
        expect(yield* server.mutate(submission)).toEqual(receipt);
      })
    )
  );

  it.effect("a pull from another client of the group lists the form client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeBackend;
        const server = yield* Server.make({ backend, auth: { policy } });
        yield* server.mutate({
          clientGroupId: "group-1",
          clientId: "form-c",
          mutationId: 1,
          mutation: bump,
          args: { id: "c3" },
        });

        const pull = yield* server.handler.handlePull({
          clientGroupId: "group-1",
          subscriptions: [Subset.make({ collection: "counters" })],
        });
        expect(pull.lastMutationIds["form-c"]).toBe(1);
        expect(pull.patch).toContainEqual(
          expect.objectContaining({ _tag: "Put", collection: "counters", id: "c3" })
        );
      })
    )
  );

  it.effect("the write is broadcast: a subscriber whose window it touches is poked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeBackend;
        const server = yield* Server.make({ backend, auth: { policy } });
        // Another group subscribes to the counters window with a first pull.
        yield* server.handler.handlePull({
          clientGroupId: "group-2",
          subscriptions: [Subset.make({ collection: "counters" })],
        });
        const poked = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.take(server.handler.pokes("group-2"), 1), () =>
            Deferred.succeed(poked, undefined)
          )
        );
        yield* Effect.yieldNow;

        yield* server.mutate({
          clientGroupId: "group-1",
          clientId: "form-d",
          mutationId: 1,
          mutation: bump,
          args: { id: "c4" },
        });
        yield* Deferred.await(poked);
      })
    )
  );

  it.effect("identity is resolved for the group and the middleware sees the push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const pushes = yield* Ref.make<ReadonlyArray<string>>([]);
        const backend = yield* makeBackendSeeing(seen);
        const server = yield* Server.make({
          backend,
          auth: {
            policy,
            identity: { resolve: (clientGroupId) => Effect.succeed(`user-of-${clientGroupId}`) },
          },
          middleware: {
            ...Authorization.passthroughMiddleware,
            onPush: (_context, request) =>
              Ref.update(pushes, (all) => [
                ...all,
                ...request.mutations.map((m) => `${m.clientId}#${m.mutationId}:${m.mutator}`),
              ]).pipe(Effect.as(request)),
          },
        });
        yield* server.mutate({
          clientGroupId: "group-1",
          clientId: "form-e",
          mutationId: 1,
          mutation: bump,
          args: { id: "c5" },
        });
        expect(yield* Ref.get(seen)).toEqual(["user-of-group-1"]);
        expect(yield* Ref.get(pushes)).toEqual(["form-e#1:counter/bump"]);
      })
    )
  );

  it.effect("the args are encoded against the Mutation's schema for the backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeBackend;
        const server = yield* Server.make({ backend, auth: { policy } });
        const receipt = yield* server.mutate({
          clientGroupId: "group-1",
          clientId: "form-f",
          mutationId: 1,
          mutation: stamp,
          args: { id: "c6", at: 42 },
        });
        expect(receipt.phase).toBe("acknowledged");
        const rows = yield* rowsOf(backend, "group-1", "c6");
        expect(rows.map((row) => row.value)).toEqual([{ id: "c6", n: 42 }]);
      })
    )
  );

  it.effect("args that do not fit the schema are a defect of the hand-over", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeBackend;
        const server = yield* Server.make({ backend, auth: { policy } });
        const exit = yield* Effect.exit(
          server.mutate({
            clientGroupId: "group-1",
            clientId: "form-g",
            mutationId: 1,
            mutation: named,
            args: { id: "" },
          })
        );
        expect(Exit.hasDies(exit)).toBe(true);
        const ledger = yield* backend
          .lastMutationIds({ clientGroupId: "group-1" })
          .pipe(Effect.orDie);
        expect(ledger["form-g"]).toBeUndefined();
      })
    )
  );
});
