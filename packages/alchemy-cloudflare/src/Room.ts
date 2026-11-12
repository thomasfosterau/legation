/**
 * Room
 *
 * The per-user Durable Object of ADR-0022's reference topology, as an Alchemy
 * Durable Object: it runs the sync `Server` for one user — push/pull/read over
 * stateless HTTP (hibernation-proof), CVRs in the object's transactional
 * storage (co-located with the user), a `FanoutBus` over the topic shards for
 * cross-room fan-out, and WebSockets that carry exactly one thing: contentless
 * poke frames, sent when a publish matches the room's leases, so hibernated
 * sockets cost nothing between writes.
 *
 * The app declares the class (the shard class beside it) and binds
 * {@link make} to it, resolving the bindings the room needs at init:
 *
 * ```ts
 * export class LegationRoom extends Cloudflare.DurableObject<LegationRoom, Room.RoomObject>()(
 *   "LegationRoom"
 * ) {}
 *
 * export const LegationRoomLive = LegationRoom.make(
 *   Effect.gen(function* () {
 *     const db = yield* Cloudflare.D1.QueryDatabase(AppDatabase);
 *     return yield* Room.make({
 *       nodes,
 *       backend: Effect.map(D1Executor.make(db), (executor) => SqlBackend.make({ executor, ... })),
 *       policy: Effect.succeed(Authorization.policy({ ... })),
 *       shards: LegationShard,
 *     });
 *   })
 * );
 * ```
 *
 * The server is built once per in-memory instance, in the object's
 * per-instance phase (Alchemy runs it under `blockConcurrencyWhile` when the
 * object is constructed, a wake from hibernation included).
 */

import * as Workers from "@alchemy.run/cloudflare/Workers";
import type { HttpEffect } from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import {
  Authorization,
  Backend,
  Query,
  type Node,
  type ProtocolError,
  type TransportError,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation";
import {
  Cvr,
  FanoutBus,
  type FanoutTopics,
  InvalidationBus,
  type Subset,
  SyncServer,
} from "@thomasfosterau/legation/internal";
import * as DurableCvrStore from "./DurableCvrStore.js";
import * as DurableFanoutBroker from "./DurableFanoutBroker.js";
import type * as FanoutShard from "./FanoutShard.js";
import {
  decodePullRequest,
  decodePushRequest,
  decodeReadRequest,
  pokeFrame,
  routeOf,
  routes,
} from "./RoomProtocol.js";

/** What the room's per-instance phase runs with: the object's state and runtime context. */
export type RoomServices = Workers.DurableObjectState | RuntimeContext;

/** The room's surface: its HTTP routes, its poke RPC and its socket handlers. */
export interface RoomObject {
  /** The room's HTTP routes ({@link routes}): push, pull, read and the poke socket. */
  readonly fetch: HttpEffect<RoomServices>;
  /**
   * The RPC a publish calls when it matched this room's leases: the topics go
   * to the room's bus, and every socket gets a contentless poke frame.
   */
  readonly poke: (topics: ReadonlyArray<string>) => Effect.Effect<void, never, RuntimeContext>;
  /** The poke channel is one-way; inbound frames are ignored. */
  readonly webSocketMessage: () => Effect.Effect<void>;
  /** A closed poke socket needs no cleanup: the room keeps no per-socket state. */
  readonly webSocketClose: () => Effect.Effect<void>;
}

/** Configuration for {@link make}: the node graph, the backend, the auth policy and the shards. */
export interface RoomConfig<R = never> {
  readonly nodes: Node.NodeRegistry;
  /**
   * The authoritative storage contract (e.g. `SqlBackend` over
   * `D1Executor.make(db)`), built in the room's per-instance phase.
   */
  readonly backend: Effect.Effect<Backend.Backend, never, RoomServices>;
  /** Deny-by-default per-collection filters, built in the per-instance phase. */
  readonly policy: Effect.Effect<Authorization.AuthPolicy, never, RoomServices>;
  /**
   * Resolve a request's identity from its credentials and client group. The
   * room presents each push, pull and read request's headers (the session
   * cookie, an API key) as its `Authorization.RequestCredentials`.
   */
  readonly identity?:
    | Effect.Effect<Authorization.IdentityResolver, never, RoomServices>
    | undefined;
  /** Named-query resolution (server-authoritative subsets). */
  readonly queries?: Effect.Effect<Query.QueryResolver, never, RoomServices> | undefined;
  /** The topic-shard namespace: the app's shard class (`LegationShard`), yielded at init. */
  readonly shards: Effect.Effect<Workers.DurableObject<FanoutShard.ShardObject>, never, R>;
  /** Shard lease heartbeat (default 30 seconds; TTL is 3×). */
  readonly heartbeat?: Duration.Input | undefined;
  /**
   * Bound on each shard or room call the room makes and each lease
   * registration; a call that exceeds it is logged and dropped, so a hung
   * shard cannot hold a push's publish open. Default 5 seconds.
   */
  readonly publishTimeout?: Duration.Input | undefined;
  /**
   * The clock the room's boot, heartbeat and request handling run on, as a test seam.
   * Unset in production (the real clock); a test passes its `TestClock` so
   * `publishTimeout` and the heartbeat move with virtual time.
   */
  readonly clock?: Clock.Clock | undefined;
}

/** Run an effect on the room's clock: the configured one, or the real clock when none is set. */
const onRoomClock = <A, E, R>(
  clock: Clock.Clock | undefined,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  clock === undefined ? effect : effect.pipe(Effect.provideService(Clock.Clock, clock));

/** What a protocol request can fail with: an undecodable body, or the handler's own errors. */
type AnswerError = ProtocolError | TransportError | VersionNotSupportedError;

/** A failed protocol request, answered as a 400 carrying the error's message. */
const badRequest = (error: AnswerError) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 }));

/** Answer one JSON protocol request with the matching handler operation. */
const answer = (handle: Effect.Effect<unknown, AnswerError>) =>
  handle.pipe(
    Effect.map((response) => HttpServerResponse.jsonUnsafe(response)),
    Effect.catchTags({
      ProtocolError: badRequest,
      TransportError: badRequest,
      VersionNotSupportedError: badRequest,
    })
  );

const notFound = HttpServerResponse.text("not found", { status: 404 });

/**
 * The room's Durable Object implementation, for `LegationRoom.make(...)`. Init
 * resolves the object's state, its own namespace (to poke sibling rooms) and
 * the shard namespace; the per-instance phase builds the sync server.
 */
export const make = <R>(
  config: RoomConfig<R>
): Effect.Effect<
  Effect.Effect<RoomObject, never, RoomServices>,
  never,
  Workers.DurableObjectState | Workers.DurableObjectScope | R
> =>
  Effect.gen(function* () {
    const state = yield* Workers.DurableObjectState;
    // SAFETY: this implementation is bound to the room class, so its own
    // namespace's objects are rooms with this `RoomObject`.
    const rooms = (yield* Workers.DurableObjectScope) as Workers.DurableObject<RoomObject>;
    const shards = yield* config.shards;

    return onRoomClock(
      config.clock,
      Effect.gen(function* () {
        // The scope lives as long as this in-memory instance; eviction tears
        // the whole isolate down, so no explicit close is needed.
        const scope = yield* Scope.make();
        const runtime = yield* RuntimeContext;
        const roomId = state.id.name ?? state.id.toString();

        /** Every poke socket gets one contentless frame. */
        const nudgeSockets = Effect.flatMap(state.getWebSockets(), (sockets) =>
          Effect.forEach(sockets, (socket) => socket.send(JSON.stringify(pokeFrame)), {
            concurrency: "unbounded",
            discard: true,
          })
        );

        return yield* Effect.gen(function* () {
          // Both bounds apply: FanoutBus wraps every broker call (lease registration included)
          // with `publishTimeout`, and the broker bounds each shard call with it too. The
          // broker's own 5 second default would cap any `publishTimeout` above 5 seconds, so the
          // forwarding here is what honours a longer bound.
          const durable: DurableFanoutBroker.DurableBroker = yield* DurableFanoutBroker.make({
            shards,
            // A publish that matched this room's own lease is delivered here, not over RPC.
            poke: (target, topics) =>
              target === roomId ? deliver(topics) : rooms.getByName(target).poke(topics),
            timeout: config.publishTimeout,
          });
          /** An inbound poke: the bus's matcher pokes the affected groups' pull loops. */
          const deliver = (topics: ReadonlyArray<FanoutTopics.Topic>) =>
            Effect.andThen(durable.notify(topics), nudgeSockets);
          // Late binding: the bus leases the room's windows, which the
          // handler's introspection provides once built.
          const subsetsRef = yield* Ref.make<Effect.Effect<ReadonlyArray<Subset.Subset>>>(
            Effect.succeed([])
          );
          const bus = yield* FanoutBus.make({
            roomId,
            broker: durable.broker,
            nodes: config.nodes,
            subsets: Ref.get(subsetsRef).pipe(Effect.flatten),
            heartbeat: config.heartbeat ?? "30 seconds",
            timeout: config.publishTimeout,
          });
          const cvrs = yield* DurableCvrStore.make(state.storage);
          let build = SyncServer.makeWithIntrospection.pipe(
            Effect.provideService(Backend.Backend, yield* config.backend),
            Effect.provideService(Authorization.AuthPolicy, yield* config.policy),
            Effect.provideService(Cvr.CvrStore, cvrs),
            Effect.provideService(InvalidationBus.InvalidationBus, bus)
          );
          if (config.identity !== undefined) {
            build = build.pipe(
              Effect.provideService(Authorization.IdentityResolver, yield* config.identity)
            );
          }
          if (config.queries !== undefined) {
            build = build.pipe(Effect.provideService(Query.QueryResolver, yield* config.queries));
          }
          const { handler, introspection } = yield* build;
          yield* Ref.set(
            subsetsRef,
            introspection.groups.pipe(
              Effect.map((groups) => groups.flatMap((group) => group.subsets))
            )
          );

          const fetch: RoomObject["fetch"] = onRoomClock(
            config.clock,
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const route = routeOf(new URL(request.url, "https://room").pathname);
              // The request's headers are its credentials (ADR-0035): the room's
              // IdentityResolver, and nothing else, sees the cookie or API key the
              // Worker forwarded unchanged.
              const presented = {
                credentials: Option.some(Authorization.credentialsFromHeaders(request.headers)),
              };
              if (route === routes.socket) {
                // The poke channel: accept under the hibernation API and hold
                // no per-socket state — eviction costs nothing.
                const [response] = yield* Workers.upgrade();
                return response;
              }
              if (route === routes.push) {
                const body = yield* request.json;
                return yield* answer(
                  Effect.flatMap(decodePushRequest(body), (decoded) =>
                    handler.handlePush(decoded, presented)
                  )
                );
              }
              if (route === routes.pull) {
                const body = yield* request.json;
                return yield* answer(
                  Effect.flatMap(decodePullRequest(body), (decoded) =>
                    handler.handlePull(decoded, presented)
                  )
                );
              }
              if (route === routes.read) {
                const body = yield* request.json;
                return yield* answer(
                  Effect.flatMap(decodeReadRequest(body), (decoded) =>
                    handler.handleRead(decoded, presented)
                  )
                );
              }
              return notFound;
            })
          );

          return {
            fetch,
            poke: (topics) =>
              onRoomClock(
                config.clock,
                deliver(topics).pipe(Effect.provideService(RuntimeContext, runtime))
              ),
            webSocketMessage: () => Effect.void,
            webSocketClose: () => Effect.void,
          } satisfies RoomObject;
        }).pipe(Scope.provide(scope));
      })
    );
  });
