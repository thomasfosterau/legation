/**
 * Test harness: Alchemy's Durable Object services stubbed at the service seam.
 *
 * Nothing here runs workerd. The Durable Object state and storage are the
 * provider's own adapters (`Workers.fromDurableObjectState`) over in-memory
 * fakes of the raw workerd objects, so the code under test calls exactly the
 * Effect-native services it calls on Cloudflare. A namespace is a map of
 * instances whose RPC methods run in-process, with each call given the
 * instance's services as Alchemy's Durable Object bridge gives them.
 */

import type * as cf from "@cloudflare/workers-types";
import * as Workers from "@alchemy.run/cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Scope from "effect/Scope";

/**
 * A partial fake of `T`: any subset of `T`'s members, each method with a
 * simplified signature. The member names are checked against `T`, so a fake
 * can't stub a member the binding doesn't have.
 */
export type Fake<T> = {
  readonly [K in keyof T]?: T[K] extends (...args: never) => void
    ? (...args: never) => void
    : unknown;
};

/**
 * Type a partial fake as the binding it stands in for. A fake implements only
 * the members the code under test calls; the provider and workerd types carry
 * many more, so no fake satisfies them structurally.
 */
export const fakeBinding = <T>(fake: Fake<T>): T =>
  // SAFETY: a test fake stands in for a third-party binding; the code under
  // test calls only the members it stubs, whose names `Fake<T>` checks.
  fake as T;

/** Alchemy's runtime context, as a Durable Object event carries it. */
export const runtimeContext: RuntimeContext["Service"] = {
  Type: "Test",
  id: "test",
  env: {},
  get: () => Effect.undefined,
  set: (id) => Effect.succeed(id),
};

/** The raw workerd storage, over a Map. */
export const makeRawStorage = (): cf.DurableObjectStorage => {
  const data = new Map<string, unknown>();
  return fakeBinding<cf.DurableObjectStorage>({
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => void data.set(key, value),
    delete: async (keys: string | ReadonlyArray<string>) =>
      P.isString(keys) ? data.delete(keys) : keys.filter((key) => data.delete(key)).length,
    list: async (options?: { prefix?: string }) => {
      const out = new Map<string, unknown>();
      Arr.forEach(data, ([key, value]) => {
        if (options?.prefix === undefined || key.startsWith(options.prefix)) out.set(key, value);
      });
      return out;
    },
  });
};

/** Alchemy's storage service over {@link makeRawStorage}. */
export const makeStorage = (): Workers.DurableObjectStorage =>
  Workers.fromDurableObjectStorage(makeRawStorage());

/** A raw socket that records the frames it was sent. */
export interface FakeSocket {
  readonly sent: Array<string>;
  send: (data: string) => void;
}

export const makeSocket = (): FakeSocket => ({
  sent: [],
  send(data) {
    this.sent.push(data);
  },
});

/** A raw workerd state named `name`, with its accepted sockets. */
export const makeRawState = (name: string) => {
  const sockets: Array<FakeSocket> = [];
  const state = fakeBinding<cf.DurableObjectState>({
    id: { name, toString: () => name },
    storage: makeRawStorage(),
    acceptWebSocket: (socket: FakeSocket) => sockets.push(socket),
    getWebSockets: () => sockets,
    waitUntil: () => undefined,
  });
  return { state, sockets };
};

/** A Durable Object implementation, as `SomeClass.make(...)` takes it (its init needs only the object's own services). */
export type Implementation<Surface> = Effect.Effect<
  Effect.Effect<Surface, never, Workers.DurableObjectState | RuntimeContext>,
  never,
  Workers.DurableObjectState | Workers.DurableObjectScope
>;

/** One constructed instance and the services its calls run with. */
export interface Instance<Surface> {
  readonly object: Surface;
  readonly sockets: Array<FakeSocket>;
  /** Run one of the instance's effects as the bridge runs a call: with its state and context. */
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, Workers.DurableObjectState | RuntimeContext | Scope.Scope>
  ) => Effect.Effect<A, E>;
}

/**
 * Construct an instance the way Alchemy's bridge does: the init phase with the
 * object's state and `DurableObjectScope` (its own namespace, `self`), then
 * the per-instance phase with its state and runtime context.
 */
export const construct = <Surface>(
  name: string,
  implementation: Implementation<Surface>,
  self: Workers.DurableObject
): Effect.Effect<Instance<Surface>> =>
  Effect.gen(function* () {
    const raw = makeRawState(name);
    const state = Workers.fromDurableObjectState(raw.state);
    const run = <A, E>(
      effect: Effect.Effect<A, E, Workers.DurableObjectState | RuntimeContext | Scope.Scope>
    ): Effect.Effect<A, E> =>
      Effect.scoped(
        effect.pipe(
          Effect.provideService(Workers.DurableObjectState, state),
          Effect.provideService(RuntimeContext, runtimeContext)
        )
      );
    const inner = yield* implementation.pipe(
      Effect.provideService(Workers.DurableObjectState, state),
      Effect.provideService(Workers.DurableObjectScope, fakeBinding<Workers.DurableObject>(self))
    );
    const object = yield* run(inner);
    return { object, sockets: raw.sockets, run };
  });

/** A Durable Object's surface, read as its members by name. */
type Members = Readonly<Record<string | symbol, unknown>>;

/**
 * An in-memory namespace over `instances`. `getByName` returns a stub whose
 * methods call the instance's, as Alchemy's RPC stub does, and whose `fetch`
 * runs the instance's `fetch` handler on the request.
 */
export const makeNamespace = <Surface extends object>(
  lookup: (name: string) => Effect.Effect<Instance<Surface>>
): Workers.DurableObject<Surface> => {
  // SAFETY: a surface is an object of named members (the bridge reads them by name too).
  const membersOf = (instance: Instance<Surface>): Members => instance.object as Members;
  return fakeBinding<Workers.DurableObject<Surface>>({
    getByName: (name: string) =>
      new Proxy(
        {},
        {
          get: (_, method) =>
            method === "fetch"
              ? (request: HttpServerRequest.HttpServerRequest) =>
                  Effect.flatMap(lookup(name), (instance) =>
                    instance.run(
                      // SAFETY: a Durable Object's `fetch` member is its HTTP handler.
                      (membersOf(instance)["fetch"] as Handler).pipe(
                        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
                        Effect.orDie
                      )
                    )
                  )
              : (...args: ReadonlyArray<unknown>) =>
                  Effect.flatMap(lookup(name), (instance) =>
                    instance.run<unknown, never>(
                      // SAFETY: every other member of a Durable Object's surface is an RPC method.
                      (
                        membersOf(instance)[method] as (
                          ...args: ReadonlyArray<unknown>
                        ) => Effect.Effect<unknown, never, RuntimeContext>
                      )(...args)
                    )
                  ),
        }
      ),
  });
};

/**
 * Runs an effect to a promise with no services of its own: the edge where this harness hands
 * Durable Object calls (a `fetch`, an RPC) to the Promise-based API they are written against.
 */
export const runPromise = Effect.runPromiseWith(Context.empty());

/** Runs an effect to its value with no services of its own: the same edge, for a synchronous seam. */
export const runSync = Effect.runSyncWith(Context.empty());

/** A Durable Object's HTTP handler, as the bridge runs it. */
type Handler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope | Workers.DurableObjectState | RuntimeContext
>;

/** Run a Durable Object `fetch` handler on a web request and answer a web response. */
export const fetchOf =
  (instance: Instance<{ readonly fetch: Handler }>) =>
  (request: Request): Promise<Response> =>
    runPromise(
      instance
        .run(
          instance.object.fetch.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request)
            ),
            Effect.orDie
          )
        )
        .pipe(Effect.map((response) => HttpServerResponse.toWeb(response)))
    );
