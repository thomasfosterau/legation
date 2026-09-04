/**
 * ElectedHost tests (#119): navigator.locks-based leader election over the
 * main-thread host path. Node has no Web Locks API, so these tests inject a
 * minimal FIFO exclusive-lock fake (`makeFakeLockManager`) via the `locks`
 * option — same queuing/abort semantics as the real API, just synchronous
 * enough to drive deterministically. Real timers throughout (mirror updates
 * and lock grants arrive on background fibers), so assertions poll like the
 * rest of the mirror test suite.
 */
import {
  Authorization,
  Backend,
  ClientStore as ClientStoreModule,
  MemoryBackend,
  Mutator,
  Node,
  Query,
  Transport,
} from "@legation/effect";
import { Cvr, InvalidationBus, Subset, SyncServer } from "@legation/effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Ref, Schema, Scope, Stream } from "effect";
import * as ElectedHost from "../ElectedHost.js";
import type { Role } from "../ElectedHost.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const TodoArgs = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean });
const todoSet = Mutator.make("todo/set", TodoArgs);
const mutations = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

const Todo = Node.make("todos", { attributes: { title: Schema.String, done: Schema.Boolean } });
const nodes = Node.registry([Todo]);

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Poll until `read` passes `until`, with a bounded number of attempts. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

/** Every `role` stream's current value (re-reads live — see `SubscriptionRef.changes`). */
const currentRole = (role: Stream.Stream<Role>) =>
  Stream.runHead(role).pipe(Effect.map(Option.getOrThrow));

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) =>
        writer.put("todos", (args as Todo).id, args)
      ),
    ])
  );
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

/**
 * A minimal FIFO exclusive-lock `LockManager`: queues same-named requests,
 * grants the next waiter when the holder's callback settles, and honors
 * `signal` both while queued and while held — everything `ElectedHost`
 * actually uses of the Web Locks API.
 */
const makeFakeLockManager = (): LockManager => {
  const queues = new Map<string, Array<() => void>>();
  const held = new Set<string>();

  const advance = (name: string) => {
    const queue = queues.get(name);
    const next = queue?.shift();
    if (next !== undefined) next();
  };

  const request = ((name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const isOptions = typeof optionsOrCallback !== "function";
    const options = (isOptions ? optionsOrCallback : {}) as LockOptions;
    const callback = (isOptions ? maybeCallback : optionsOrCallback) as (
      lock: Lock | null
    ) => unknown;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const attempt = () => {
        if (settled) return;
        if (held.has(name)) {
          const queue = queues.get(name) ?? [];
          queue.push(attempt);
          queues.set(name, queue);
          return;
        }
        held.add(name);
        Promise.resolve(callback({ mode: options.mode ?? "exclusive", name } as Lock)).then(
          (value) => {
            held.delete(name);
            settled = true;
            resolve(value);
            advance(name);
          },
          (error: unknown) => {
            held.delete(name);
            settled = true;
            reject(error as Error);
            advance(name);
          }
        );
      };
      options.signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        const queue = queues.get(name);
        if (queue !== undefined)
          queues.set(
            name,
            queue.filter((fn) => fn !== attempt)
          );
        reject(new Error("aborted"));
      });
      attempt();
    });
  }) as LockManager["request"];

  return { request, query: () => Promise.resolve({ held: [], pending: [] }) } as LockManager;
};

const dependenciesOf = (
  handler: Transport.ServerHandler,
  store: ClientStoreModule.ClientStore,
  clientGroupId: string
): Layer.Layer<ClientStoreModule.ClientStore | Transport.ClientTransport> =>
  Layer.mergeAll(
    Layer.succeed(ClientStoreModule.ClientStore)(store),
    Layer.effect(Transport.ClientTransport)(Transport.makeInMemory(handler, clientGroupId))
  );

describe("ElectedHost (#119)", () => {
  // Real clock: the periodic pull runs on `Schedule.spaced`, which the
  // TestClock would freeze.
  it.live(
    "the hosting tab's own pin survives a mirror's subscribe and unsubscribe of the same window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const locks = makeFakeLockManager();
          const clientGroupId = `group-voice-${Date.now()}`;
          const channelName = `legation-elected-voice-${Date.now()}`;
          const handler = yield* makeServer;
          const store = yield* ClientStoreModule.makeMemory;
          // The engine's subscription list is observable through what each
          // pull carries: record it from the transport the host is wired with.
          const pulls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const dependencies = Layer.mergeAll(
            Layer.succeed(ClientStoreModule.ClientStore)(store),
            Layer.effect(Transport.ClientTransport)(
              Effect.map(
                Transport.makeInMemory(handler, clientGroupId),
                (transport): Transport.ClientTransport => ({
                  ...transport,
                  pull: (request) =>
                    Ref.update(pulls, (seen) => [
                      ...seen,
                      request.subscriptions.map(Subset.hash),
                    ]).pipe(Effect.andThen(transport.pull(request))),
                })
              )
            )
          );
          const options = {
            clientGroupId,
            nodes,
            mutations,
            channelName,
            locks,
            dependencies,
            syncLoop: { pushDebounce: "5 millis" as const, pullInterval: "20 millis" as const },
          };
          const read = { collection: "todos" };
          const root = Subset.hash(Query.plan(nodes, read).root);

          const tabA = yield* ElectedHost.run(options);
          yield* eventually(currentRole(tabA.role), (role) => role === "host");
          const tabB = yield* ElectedHost.run(options);
          expect(yield* currentRole(tabB.role)).toBe("mirror");

          // The host's own Client pins the window; a mirror comes and goes.
          yield* tabA.client.subscribe(read).pipe(Effect.orDie);
          yield* tabB.client.subscribe(read).pipe(Effect.orDie);
          yield* eventually(Ref.get(pulls), (seen) => seen.at(-1)?.includes(root) === true);
          yield* tabB.client.unsubscribe(read).pipe(Effect.orDie);

          // Every pull after the mirror let go still carries the window:
          // both fronts count on one voice, so the mirror's release was not
          // the last hold.
          const before = (yield* Ref.get(pulls)).length;
          const seen = yield* eventually(Ref.get(pulls), (all) => all.length >= before + 3);
          expect(seen.slice(before).every((subscriptions) => subscriptions.includes(root))).toBe(
            true
          );
        })
      )
  );

  it.effect(
    "exactly one tab hosts; the second mirrors, and death promotes it from the persisted store",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const locks = makeFakeLockManager();
          const clientGroupId = `group-${Date.now()}`;
          const channelName = `legation-elected-${Date.now()}`;
          const handler = yield* makeServer;
          const store = yield* ClientStoreModule.makeMemory;
          const options = {
            clientGroupId,
            nodes,
            mutations,
            channelName,
            locks,
            dependencies: dependenciesOf(handler, store, clientGroupId),
            syncLoop: { pushDebounce: "5 millis" as const },
          };

          // Tab B is built with its own explicit (outer-scoped) lifetime so
          // it survives past the nested block below where tab A lives and
          // dies — but it's still built AFTER tab A textually inside that
          // block, so tab A is the first to request the lock and wins it.
          const survivorScope = yield* Scope.make();

          const survivor = yield* Effect.scoped(
            Effect.gen(function* () {
              const tabA = yield* ElectedHost.run(options);
              yield* eventually(currentRole(tabA.role), (role) => role === "host");

              const tabB = yield* ElectedHost.run(options).pipe(Scope.provide(survivorScope));
              // Still a mirror while tab A holds the lock.
              expect(yield* currentRole(tabB.role)).toBe("mirror");
              // Pin the read so the mirror actually registers interest and
              // hydrates from broadcasts (observing/subscribing IS what
              // makes a mirror carry a key — ADR-0021).
              yield* tabB.client.subscribe({ collection: "todos" }).pipe(Effect.orDie);

              yield* tabA.client.mutate("todo/set", {
                id: "1",
                title: "written by the leader",
                done: false,
              });
              // The mirror in tab B sees it over the broadcast channel.
              yield* eventually(
                tabB.client.query({ collection: "todos" }).pipe(
                  Effect.orDie,
                  Effect.map((current) => current.length)
                ),
                (count) => count === 1
              );
              return tabB;
            })
          );
          // Tab A's scope just closed — modelling the leader tab closing.

          // Tab B wins the now-released lock and takes over hosting.
          yield* eventually(currentRole(survivor.role), (role) => role === "host");

          // Resumed from the SAME durable store: the old leader's row is
          // still there without tab B ever having journaled it itself.
          const rows = yield* survivor.client.query({ collection: "todos" }).pipe(Effect.orDie);
          expect(rows.map((row) => (row.value as Todo).title)).toEqual(["written by the leader"]);

          // And tab B, now the host, can journal new mutations itself.
          yield* survivor.client
            .mutate("todo/set", { id: "2", title: "written by the successor", done: false })
            .pipe(Effect.orDie);
          yield* eventually(
            survivor.client.query({ collection: "todos" }).pipe(
              Effect.orDie,
              Effect.map((current) => current.length)
            ),
            (count) => count === 2
          );
          yield* Scope.close(survivorScope, Exit.void);
        })
      )
  );

  it.effect("kill-leader-mid-mutation: a mirror-forwarded mutation is never silently lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const locks = makeFakeLockManager();
        const clientGroupId = `group-kill-${Date.now()}`;
        const channelName = `legation-elected-kill-${Date.now()}`;
        const handler = yield* makeServer;
        const store = yield* ClientStoreModule.makeMemory;
        const options = {
          clientGroupId,
          nodes,
          mutations,
          channelName,
          locks,
          dependencies: dependenciesOf(handler, store, clientGroupId),
          syncLoop: { pushDebounce: "5 millis" as const },
        };

        // Tab A is created first inside the nested (killable) block, so it
        // wins the race; tab B is built after it, tied to its own
        // outer-scoped lifetime so it survives tab A's death below and
        // stays a mirror right up until the kill — the scenario the
        // acceptance criteria describes: a mirror-forwarded mutation,
        // forwarded to a leader that dies before the mirror learns the
        // outcome.
        const survivorScope = yield* Scope.make();

        const [survivor, inFlight] = yield* Effect.scoped(
          Effect.gen(function* () {
            const tabA = yield* ElectedHost.run(options);
            yield* eventually(currentRole(tabA.role), (role) => role === "host");

            const tabB = yield* ElectedHost.run(options).pipe(Scope.provide(survivorScope));

            // Forward a mutation and wait only until the LEADER has
            // durably journaled it (not until it's acked) — then kill the
            // leader before the mirror ever learns the outcome.
            const fiber = yield* Effect.forkChild(
              tabB.client.mutate("todo/set", { id: "orphan", title: "mid-flight", done: false })
            );
            yield* eventually(
              store.pendingMutations.pipe(Effect.orDie),
              (pending) => pending.length === 1
            );
            return [tabB, fiber] as const;
          })
        );
        // Tab A is dead — its scope closed above. Tab B wins the
        // now-released lock and takes over.
        yield* eventually(currentRole(survivor.role), (role) => role === "host");

        // The caller is never left hanging forever: the forked mutate call
        // settles — successfully or with a visible failure — well within a
        // bounded window (`Effect.exit` turns either outcome into a value
        // so the timeout wrapper only ever measures "did it hang").
        const settled = yield* Effect.exit(Fiber.join(inFlight)).pipe(
          Effect.timeoutOption("3 seconds")
        );
        expect(Option.isSome(settled)).toBe(true);

        // Whichever outcome the caller saw, the mutation itself was never
        // silently dropped: it was durably journaled before tab A died, and
        // tab B's sync loop — same client id, same store — pushes it to
        // the real backend once it takes over.
        yield* eventually(
          store.pendingMutations.pipe(Effect.orDie),
          (pending) => pending.length === 0
        );
        const rows = yield* survivor.client.query({ collection: "todos" }).pipe(Effect.orDie);
        expect(rows.map((row) => row.id)).toContain("orphan");
        yield* Scope.close(survivorScope, Exit.void);
      })
    )
  );

  it.effect(
    "without navigator.locks, a tab becomes host immediately (documented single-tab fallback)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const clientGroupId = `group-nolocks-${Date.now()}`;
          const channelName = `legation-elected-nolocks-${Date.now()}`;
          const handler = yield* makeServer;
          const store = yield* ClientStoreModule.makeMemory;
          // No `locks` option: falls back to the ambient `navigator.locks`,
          // which this Node test environment doesn't have.
          const tab = yield* ElectedHost.run({
            clientGroupId,
            nodes,
            mutations,
            channelName,
            dependencies: dependenciesOf(handler, store, clientGroupId),
            syncLoop: { pushDebounce: "5 millis" as const },
          });

          yield* eventually(currentRole(tab.role), (role) => role === "host");
        })
      )
  );
});
