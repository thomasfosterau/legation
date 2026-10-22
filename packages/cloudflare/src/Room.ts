/**
 * Room
 *
 * The per-user Durable Object of ADR-0022's reference topology: it runs
 * the sync `Server` for one user — push/pull/read over stateless HTTP
 * (hibernation-proof), CVRs in the object's transactional storage
 * (co-located with the user), a `FanoutBus` over the topic shards for
 * cross-room fan-out, and WebSockets that carry exactly one thing:
 * contentless poke frames, sent on shard wake-ups so hibernated sockets
 * cost nothing between writes.
 *
 * `makeRoomClass` returns a class to export from the Worker entry:
 *
 * ```ts
 * export class LegationRoom extends makeRoomClass({
 *   nodes,
 *   backend: (env) => SqlBackend.make({ executor: D1Executor.make(env.DB), ... }),
 *   policy: () => Authorization.policy({ ... }),
 *   shards: (env) => env.SHARDS,
 * }) {}
 * ```
 */

import type {
  DurableObjectNamespace,
  DurableObjectState,
  WebSocket,
} from "@cloudflare/workers-types";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import {
  Authorization,
  Backend,
  Query,
  type Node,
  type ProtocolError,
  type Transport,
  type TransportError,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation-effect";
import {
  Cvr,
  FanoutBus,
  InvalidationBus,
  type Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import * as DurableCvrStore from "./DurableCvrStore.js";
import * as DurableFanoutBroker from "./DurableFanoutBroker.js";
import { type RoomSocket, upgradeResponse, webSocketPair } from "./Platform.js";
import {
  decodePullRequest,
  decodePushRequest,
  decodeReadRequest,
  decodeShardPoke,
  pokeFrame,
  routes,
} from "./RoomProtocol.js";

/** Configuration for {@link makeRoomClass}: the node graph, the backend and the auth policy. */
export interface RoomConfig<Env> {
  readonly nodes: Node.NodeRegistry;
  /** The authoritative storage contract (e.g. `SqlBackend` over D1). */
  readonly backend: (env: Env) => Backend.Backend;
  /** Deny-by-default per-collection filters. */
  readonly policy: (env: Env) => Authorization.AuthPolicy;
  /** Resolve a client group to its identity (session binding). */
  readonly identity?: (env: Env) => Authorization.IdentityResolver;
  /** Named-query resolution (server-authoritative subsets). */
  readonly queries?: (env: Env) => Query.QueryResolver;
  /** The topic-shard namespace binding. */
  readonly shards: (env: Env) => DurableObjectNamespace;
  /** Shard lease heartbeat (default 30 seconds; TTL is 3×). */
  readonly heartbeat?: Duration.Input;
  /**
   * Bound on each shard call and lease registration the room makes; a call that exceeds it is
   * logged and dropped, so a hung shard cannot hold a push's publish open. Default 5 seconds.
   */
  readonly publishTimeout?: Duration.Input | undefined;
  /**
   * The clock the room's boot, heartbeat and request handling run on, as a test seam.
   * Unset in production (the real clock); a test passes its `TestClock` so
   * `publishTimeout` and the heartbeat move with virtual time.
   */
  readonly clock?: Clock.Clock | undefined;
}

interface RoomRuntime {
  readonly handler: Transport.ServerHandler;
  /** Feed an inbound shard poke to the bus (the local matcher pokes groups). */
  readonly notify: (topics: ReadonlyArray<string>) => Effect.Effect<void>;
}

/** Run an effect on the room's clock: the configured one, or the real clock when none is set. */
const onRoomClock = <A, E, R>(
  clock: Clock.Clock | undefined,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  clock === undefined ? effect : effect.pipe(Effect.provideService(Clock.Clock, clock));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Assemble the room's server once per in-memory Durable Object lifetime. */
const boot = <Env>(
  config: RoomConfig<Env>,
  state: DurableObjectState,
  env: Env
): Promise<RoomRuntime> =>
  Effect.runPromise(
    onRoomClock(
      config.clock,
      Effect.gen(function* () {
        // The scope lives as long as this in-memory instance; eviction tears
        // the whole isolate down, so no explicit close is needed.
        const scope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const roomId = state.id.name ?? state.id.toString();
          // Both bounds apply: FanoutBus wraps every broker call (lease registration included)
          // with `publishTimeout`, and the broker bounds each shard call with it too. The
          // broker's own 5 second default would cap any `publishTimeout` above 5 seconds, so the
          // forwarding here is what honours a longer bound.
          const durable = yield* DurableFanoutBroker.make({
            shards: config.shards(env),
            timeout: config.publishTimeout,
          });
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
          let build = SyncServer.makeWithIntrospection.pipe(
            Effect.provideService(Backend.Backend, config.backend(env)),
            Effect.provideService(Authorization.AuthPolicy, config.policy(env)),
            Effect.provideService(Cvr.CvrStore, DurableCvrStore.make(state.storage)),
            Effect.provideService(InvalidationBus.InvalidationBus, bus)
          );
          if (config.identity !== undefined) {
            build = build.pipe(
              Effect.provideService(Authorization.IdentityResolver, config.identity(env))
            );
          }
          if (config.queries !== undefined) {
            build = build.pipe(Effect.provideService(Query.QueryResolver, config.queries(env)));
          }
          const { handler, introspection } = yield* build;
          yield* Ref.set(
            subsetsRef,
            introspection.groups.pipe(
              Effect.map((groups) => groups.flatMap((group) => group.subsets))
            )
          );
          return { handler, notify: durable.notify };
        }).pipe(Scope.provide(scope));
      })
    )
  );

/** What a protocol request can fail with: an undecodable body, or the handler's own errors. */
type AnswerError = ProtocolError | TransportError | VersionNotSupportedError;

/** A failed protocol request, answered as a 400 carrying the error's message. */
const badRequest = (error: AnswerError) => Effect.succeed(json({ error: error.message }, 400));

/** Answer one JSON protocol request with the matching handler operation. */
const answer = (
  clock: Clock.Clock | undefined,
  handle: Effect.Effect<unknown, AnswerError>
): Promise<Response> =>
  Effect.runPromise(
    onRoomClock(
      clock,
      handle.pipe(
        Effect.map((response) => json(response)),
        Effect.catchTags({
          ProtocolError: badRequest,
          TransportError: badRequest,
          VersionNotSupportedError: badRequest,
        })
      )
    )
  );

/**
 * Build the room's Durable Object class.
 *
 * The constructor type is written out because declaration emit cannot
 * describe an exported anonymous class that has `#private` members.
 */
export const makeRoomClass = <Env>(
  config: RoomConfig<Env>
): new (
  state: DurableObjectState,
  env: Env
) => {
  readonly state: DurableObjectState;
  readonly env: Env;
  fetch(request: Request): Promise<Response>;
  webSocketMessage(): Promise<void>;
  webSocketClose(): Promise<void>;
} =>
  class LegationRoom {
    #runtime: Promise<RoomRuntime> | undefined;

    constructor(
      readonly state: DurableObjectState,
      readonly env: Env
    ) {}

    #boot(): Promise<RoomRuntime> {
      this.#runtime ??= boot(config, this.state, this.env);
      return this.#runtime;
    }

    async fetch(request: Request): Promise<Response> {
      const runtime = await this.#boot();
      const url = new URL(request.url);

      if (url.pathname === routes.socket) {
        // The poke channel: accept under the hibernation API and hold no
        // per-socket state — eviction costs nothing.
        const pair = webSocketPair();
        this.state.acceptWebSocket(pair.server as WebSocket);
        return upgradeResponse(pair.client);
      }
      if (url.pathname === routes.poke) {
        const topics = await Effect.runPromise(
          onRoomClock(config.clock, decodeShardPoke(await request.json()).pipe(Effect.orDie))
        );
        // Wake path: hand the topics to the bus (its matcher pokes the
        // affected client groups' pull loops) AND nudge every socket —
        // a contentless frame is all a hibernated client needs.
        await Effect.runPromise(onRoomClock(config.clock, runtime.notify([...topics.topics])));
        for (const socket of this.state.getWebSockets()) {
          (socket as RoomSocket).send(JSON.stringify(pokeFrame));
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === routes.push) {
        const body: unknown = await request.json();
        return answer(
          config.clock,
          Effect.flatMap(decodePushRequest(body), (decoded) => runtime.handler.handlePush(decoded))
        );
      }
      if (url.pathname === routes.pull) {
        const body: unknown = await request.json();
        return answer(
          config.clock,
          Effect.flatMap(decodePullRequest(body), (decoded) => runtime.handler.handlePull(decoded))
        );
      }
      if (url.pathname === routes.read) {
        const body: unknown = await request.json();
        return answer(
          config.clock,
          Effect.flatMap(decodeReadRequest(body), (decoded) => runtime.handler.handleRead(decoded))
        );
      }
      return new Response("not found", { status: 404 });
    }

    // The poke channel is one-way; inbound frames are ignored.
    async webSocketMessage(): Promise<void> {}
    async webSocketClose(): Promise<void> {}
  };
