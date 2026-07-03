/**
 * Server
 *
 * The one server-side object (ADR-0022): built once over the {@link Backend}
 * and auth seams, it exposes the protocol **handler** (push/pull with CVR
 * diffing — mount it on any router or carrier) and **broadcast**, the single
 * verb for "these resources changed".
 *
 * Mutation writes pushed through the handler broadcast implicitly (the push
 * path publishes their hints); `broadcast` is for everything else — cron
 * jobs, admin tools, any writer that bypasses mutations (ADR-0019's
 * out-of-band story in one line). Underneath it is unchanged poke-then-pull:
 * hints are droppable latency optimizations, pull is the correctness path.
 *
 * CVR storage and the fan-out bus are **options with working defaults**
 * (in-memory store, in-process bus); scale-out swaps them (a shared
 * KeyValueStore, a serialized broker — ADR-0011) without touching app code.
 * The Server is logical: its parts deploy separately (per-user rooms,
 * fan-out shards — ADR-0022's reference topology), and ADR-0023's
 * topic-derived fan-out lands behind `broadcast` without changing its
 * signature.
 */

import { Effect, Scope } from "effect";
import * as Authorization from "./Authorization.js";
import { Backend, type Backend as BackendService } from "./Backend.js";
import * as Cvr from "./Cvr.js";
import * as InvalidationBus from "./InvalidationBus.js";
import * as Query from "./Query.js";
import * as SyncServer from "./SyncServer.js";
import type * as Transport from "./Transport.js";

/** A change announcement for {@link Server.broadcast}. */
export interface Broadcast {
  readonly collection: string;
  /** The changed row ids, when the writer knows them (finer fan-out). */
  readonly ids?: ReadonlyArray<string>;
}

export interface Server {
  /** The sync protocol handler — mount it on any router or carrier. */
  readonly handler: Transport.ServerHandler;
  /**
   * Announce out-of-band changes: subscribers whose windows may be
   * affected are poked and pull. Writes pushed through {@link handler}
   * broadcast implicitly.
   */
  readonly broadcast: (change: Broadcast) => Effect.Effect<void>;
}

export interface MakeOptions {
  /** The storage contract (ADR-0009). */
  readonly backend: BackendService;
  readonly auth: {
    /** Deny-by-default per-collection filters. */
    readonly policy: Authorization.AuthPolicy;
    /** Resolve a client group to its identity (session binding). */
    readonly identity?: Authorization.IdentityResolver;
  };
  /** Named-query resolution (server-authoritative subsets). */
  readonly queries?: Query.QueryResolver;
  /** Cross-cutting interception (tenancy, cost control, telemetry). */
  readonly middleware?: Authorization.SyncMiddleware;
  /** CVR storage; defaults to in-memory. */
  readonly cvr?: Cvr.CvrStore;
  /** The hint fan-out bus; defaults to in-process. */
  readonly bus?: InvalidationBus.InvalidationBus;
  /** Handler tuning passthrough. */
  readonly options?: SyncServer.SyncServerOptions;
}

/** Build the Server: handler + broadcast over backend and auth. */
export const make = (options: MakeOptions): Effect.Effect<Server, never, Scope.Scope> =>
  Effect.gen(function* () {
    const cvr = options.cvr ?? (yield* Cvr.makeMemoryStore);
    const bus = options.bus ?? (yield* InvalidationBus.makeInProcess);
    let handler = SyncServer.makeWith(options.options).pipe(
      Effect.provideService(Backend, options.backend),
      Effect.provideService(Authorization.AuthPolicy, options.auth.policy),
      Effect.provideService(Cvr.CvrStore, cvr),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
    if (options.auth.identity !== undefined) {
      handler = handler.pipe(
        Effect.provideService(Authorization.IdentityResolver, options.auth.identity)
      );
    }
    if (options.queries !== undefined) {
      handler = handler.pipe(Effect.provideService(Query.QueryResolver, options.queries));
    }
    if (options.middleware !== undefined) {
      handler = handler.pipe(
        Effect.provideService(Authorization.SyncMiddleware, options.middleware)
      );
    }
    return {
      handler: yield* handler,
      broadcast: (change) =>
        bus.publish([{ collection: change.collection, ids: change.ids ?? [] }]),
    };
  });
