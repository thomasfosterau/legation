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
 *
 * A third verb, **mutate**, runs one named Mutation server-side as one of a
 * client group's mutations (ADR-0030, amendment #215): the entry point a form
 * action calls. It is a push minus the transport, so it goes through the
 * handler's push path (identity, middleware, the backend's ledger, the
 * broadcast), and it answers a {@link Receipt} carrying the backend's ruling.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Authorization from "./Authorization.js";
import { Backend, type Backend as BackendService } from "./Backend.js";
import * as Cvr from "./Cvr.js";
import { BackendError, type TransportError, type VersionNotSupportedError } from "./Errors.js";
import * as InvalidationBus from "./InvalidationBus.js";
import type * as Mutator from "./Mutator.js";
import type { PushResponse } from "./Protocol.js";
import * as Query from "./Query.js";
import * as SyncServer from "./SyncServer.js";
import type * as Transport from "./Transport.js";

/** A change announcement for {@link Server.broadcast}. */
export interface Broadcast {
  readonly collection: string;
  /** The changed row ids, when the writer knows them (finer fan-out). */
  readonly ids?: ReadonlyArray<string>;
}

/**
 * One Mutation for {@link Server.mutate} to run: the client group, the client
 * and mutation id that name it, and the Mutation with its args.
 *
 * A form action passes a **form client** id minted for the rendered form, with
 * mutation id `1` (ADR-0030 #215 §2). A mutation id is per client and
 * contiguous, so the action must not borrow the next id of a tab's engine.
 */
export interface MutateRequest<Args, ArgsEncoded> {
  /** The client group the mutation belongs to (ADR-0020's client-group cookie). */
  readonly clientGroupId: string;
  /** The client that names the mutation: a form client id for a form action. */
  readonly clientId: string;
  /** The mutation's id for that client: `1` for a freshly rendered form. */
  readonly mutationId: number;
  /** The Mutation definition to run; its name selects the backend's handler. */
  readonly mutation: Mutator.Mutator<string, Args, ArgsEncoded>;
  /**
   * The args, as the form layer hands them over: decoded and validated. They
   * are encoded against `mutation.args` for the backend, which decodes them
   * again as for a pushed mutation.
   */
  readonly args: Args;
  /** The schema version to check, as a push carries it (#48); unset when omitted. */
  readonly schemaVersion?: string | undefined;
}

/**
 * What {@link Server.mutate} answers: the mutation it ran, named by its client
 * and mutation id, and the backend's ruling (ADR-0030 #215 §3). The phase uses
 * `MutationState`'s vocabulary: `acknowledged`, or `rejected` with the reason
 * the backend gave. A client holding an optimistic effect for this mutation
 * releases it when a pull's `lastMutationIds` covers it, not on the receipt.
 */
export type Receipt =
  | {
      readonly clientId: string;
      readonly mutationId: number;
      readonly phase: "acknowledged";
    }
  | {
      readonly clientId: string;
      readonly mutationId: number;
      readonly phase: "rejected";
      /** The backend's permanent-rejection reason. */
      readonly reason: string;
    };

/** One per backend: the protocol `handler` plus `broadcast` for out-of-band changes. */
export interface Server {
  /** The sync protocol handler — mount it on any router or carrier. */
  readonly handler: Transport.ServerHandler;
  /**
   * Announce out-of-band changes: subscribers whose windows may be
   * affected are poked and pull. Writes pushed through {@link handler}
   * broadcast implicitly.
   */
  readonly broadcast: (change: Broadcast) => Effect.Effect<void>;
  /**
   * Run one named Mutation as one of a client group's mutations, and answer
   * its {@link Receipt} (ADR-0030 #215 §1–§3).
   *
   * The path is the push path minus the transport: the group's identity is
   * resolved through the `IdentityResolver`, the middleware's `onPush` runs,
   * the backend applies the mutation with its id bumped in the same
   * transaction as its effects (a permanent rejection bumps it with no
   * effects, ADR-0008), and the write's hints are broadcast as a pushed
   * write's are. A pull from any client of the group then lists `clientId` in
   * `lastMutationIds`.
   *
   * A resubmission of the same `(clientId, mutationId)` is a replay: the
   * backend's ledger skips it, the handler does not run again, and the call
   * answers the original ruling (a rejection from the backend's rejection
   * memory, Backend guarantee 4).
   *
   * Args that do not encode against the Mutation's schema are a defect of the
   * hand-over from the form layer, not a field error (§5): the effect dies.
   * Every other failure (identity, middleware, a transient backend error, an
   * unsupported schema version) fails as the push path does.
   */
  readonly mutate: <Args, ArgsEncoded>(
    request: MutateRequest<Args, ArgsEncoded>
  ) => Effect.Effect<Receipt, TransportError | VersionNotSupportedError>;
}

/**
 * Read one mutation's ruling off a push response: rejected when the response
 * lists it, acknowledged when the client's watermark covers it. A response
 * that does neither breaks Backend guarantee 1, so it is a defect.
 */
const receiptOf = (
  response: PushResponse,
  clientId: string,
  mutationId: number
): Effect.Effect<Receipt> => {
  const rejected = response.rejected?.find(
    (entry) => entry.clientId === clientId && entry.mutationId === mutationId
  );
  if (rejected !== undefined) {
    return Effect.succeed({ clientId, mutationId, phase: "rejected", reason: rejected.reason });
  }
  const watermark = response.lastMutationIds[clientId] ?? 0;
  return watermark >= mutationId
    ? Effect.succeed({ clientId, mutationId, phase: "acknowledged" })
    : Effect.die(
        new BackendError({
          message: `Server.mutate: the backend neither applied nor rejected mutation ${mutationId} of client ${clientId} (its watermark is ${watermark})`,
        })
      );
};

/**
 * Options for {@link make}: the backend and auth are required; CVR storage and the bus default
 * to in-memory / in-process.
 */
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
    const built = yield* handler;
    const mutate = <Args, ArgsEncoded>(
      request: MutateRequest<Args, ArgsEncoded>
    ): Effect.Effect<Receipt, TransportError | VersionNotSupportedError> =>
      Effect.gen(function* () {
        const args = yield* Schema.encodeEffect(request.mutation.args)(request.args).pipe(
          Effect.orDie
        );
        const createdAt = yield* Clock.currentTimeMillis;
        const response = yield* built.handlePush({
          clientGroupId: request.clientGroupId,
          mutations: [
            {
              clientId: request.clientId,
              mutationId: request.mutationId,
              mutator: request.mutation.name,
              args,
              createdAt,
            },
          ],
          schemaVersion: request.schemaVersion,
        });
        return yield* receiptOf(response, request.clientId, request.mutationId);
      });
    return {
      handler: built,
      broadcast: (change) =>
        bus.publish([{ collection: change.collection, ids: change.ids ?? [] }]),
      mutate,
    };
  });
