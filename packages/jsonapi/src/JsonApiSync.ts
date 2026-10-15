/**
 * JsonApiSync
 *
 * The happy path: hand it an app's JSON:API `HttpApi` and get a fully wired,
 * offline-capable sync engine. It reflects the api into resources
 * (Convention.ts), derives collections + CRUD mutators (Derive.ts), and
 * composes the JsonApiBackend with an in-process sync room and the client
 * engine — so the app's existing REST API gains optimistic writes, a durable
 * journal, rebase, and live queries with no extra server to deploy
 * (client-direct deployment; "realtime" is periodic pull).
 *
 * The same JsonApiBackend satisfies the BYO `Backend` contract, so a later
 * server-side deployment for CVR fan-out reuses it unchanged.
 *
 * When the api advertises the JSON:API Atomic Operations extension (an
 * endpoint taking an `atomic:operations` document), pushes go to it as one
 * all-or-nothing request per batch; otherwise each mutation is replayed as
 * its own request (`JsonApiSyncOptions.atomic`).
 */

import { Duration, Effect, Layer, Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type { KeyValueStore } from "effect/persistence";
import { Authorization, Backend, ClientStore, Transport } from "@thomasfosterau/legation-effect";
import { ClientEngine, SyncRoom } from "@thomasfosterau/legation-effect/internal";
import {
  reflectAtomic,
  reflectResources,
  type EndpointRef,
  type ResourceMap,
} from "./Convention.js";
import { derive, type Derived } from "./Derive.js";
import * as JsonApiBackend from "./JsonApiBackend.js";
import type { QueryEncoder } from "./JsonApiQuery.js";
import * as Ledger from "./Ledger.js";

/**
 * An app's JSON:API surface defined with Effect `HttpApi`, with its identifier
 * and group types erased. `HttpApi`'s group parameter is invariant, so the
 * entry points below are generic over the concrete api rather than accepting
 * this alias directly.
 */
export type JsonApi = HttpApi.Constraint;

/** Options for {@link layer}. */
export interface JsonApiSyncOptions {
  /** Base URL the resource paths resolve against (no trailing slash). */
  readonly baseUrl: string;
  /** This client's id (stable per device/tab). */
  readonly clientId: string;
  /** The client group this client belongs to (shared journal scope). */
  readonly clientGroupId: string;
  /** Override the Subset → JSON:API query encoding (e.g. your own package). */
  readonly queryEncoder?: QueryEncoder | undefined;
  /**
   * Relationship names to compound-load per collection (`?include=...`), so
   * `Relationships.related` resolves them without extra round trips.
   */
  readonly includes?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  /**
   * Where the backend keeps its ledger (acknowledged mutation ids and remembered
   * rejections) across restarts (#468). Unset, it is `Ledger.keyValue` over
   * `keyValueStore` when that is given, and otherwise in memory, where a restart
   * of the backend forgets it.
   */
  readonly ledger?: Ledger.LedgerStore | undefined;
  /**
   * The durable Effect `KeyValueStore` behind the client store (#468). When it is
   * set and `ledger` is not, the ledger defaults to `Ledger.keyValue` over it, so
   * a durable client store keeps its ledger and rejection memory across a reload.
   * `store` is an opaque layer, so the layer cannot check that it is built over
   * this key/value store: pass the same one to both, e.g.
   * `ClientStore.layerKeyValue()` provided with it.
   */
  readonly keyValueStore?: KeyValueStore.KeyValueStore | undefined;
  /**
   * Atomic operations. When the api advertises the JSON:API Atomic Operations
   * extension (an endpoint taking an `atomic:operations` document, e.g.
   * effect-jsonapi's `Endpoint.operations`), the backend pushes each batch as
   * one all-or-nothing request to it — detected from the api by default.
   * Pass `false` to keep one request per mutation, or `{ path }` to name the
   * endpoint explicitly (an api that serves it outside the reflected
   * `HttpApi`).
   */
  readonly atomic?: false | { readonly path: string } | undefined;
  /**
   * Periodic pull interval — the correctness backstop that picks up changes
   * made elsewhere ("realtime" is periodic pull for client-direct deployment).
   * Defaults to 5 seconds; set to `null` to disable interval pulling.
   */
  readonly pullInterval?: Duration.Input | null | undefined;
  /**
   * Auto-push debounce window. When set, mutations are pushed automatically
   * (coalesced) without an app-level `push` call.
   */
  readonly pushDebounce?: Duration.Input | undefined;
  /**
   * The client store backing the engine. Defaults to the in-memory store —
   * supply a durable one (e.g. `IndexedDbClientStore.layerWindow()` from
   * `@thomasfosterau/legation-browser`, or `ClientStore.layerKeyValue` over localStorage) so
   * the journal and confirmed rows survive reloads (offline-first).
   */
  readonly store?: Layer.Layer<ClientStore.ClientStore> | undefined;
}

/**
 * Reflect + derive an api's resources, collections, mutators, operations —
 * and its atomic operations endpoint, when it declares one.
 */
export const inspect = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): { readonly resources: ResourceMap; readonly atomic?: EndpointRef } & Derived => {
  const resources = reflectResources(api);
  const atomic = reflectAtomic(api);
  return { resources, ...(atomic !== undefined ? { atomic } : {}), ...derive(resources) };
};

/** Every resource collection is readable; the REST API enforces real auth. */
const authPolicy = (resources: ResourceMap): Authorization.AuthPolicy =>
  Authorization.policy(
    Object.fromEntries([...resources.keys()].map((type) => [type, Authorization.allowAll]))
  );

/**
 * The full client-direct stack as a layer: provide an `HttpClient`, get a
 * ready `ClientEngine`. CVR store and invalidation bus are in-process; the
 * client store defaults to in-memory (pass `store` for durable offline
 * persistence across reloads, and `keyValueStore` with it to keep the ledger
 * durable too).
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  options: JsonApiSyncOptions
): Layer.Layer<ClientEngine.ClientEngine, never, HttpClient.HttpClient> => {
  const { resources, registry, operations, atomic } = inspect(api);
  // Atomic pushes when the api advertises the extension, unless opted out;
  // an explicit path overrides what reflection found.
  const atomicPath = options.atomic === false ? undefined : (options.atomic?.path ?? atomic?.path);

  // A durable key/value store makes the ledger durable too, unless the app names one.
  const ledger =
    options.ledger ??
    (options.keyValueStore !== undefined ? Ledger.keyValue(options.keyValueStore) : undefined);

  const backendLayer = Layer.effect(Backend.Backend)(
    JsonApiBackend.make({
      baseUrl: options.baseUrl,
      resources,
      mutators: registry.mutators,
      operations,
      ...(atomicPath !== undefined ? { atomic: { path: atomicPath } } : {}),
      ...(options.queryEncoder !== undefined ? { query: options.queryEncoder } : {}),
      ...(options.includes !== undefined ? { includes: options.includes } : {}),
      ...(ledger !== undefined ? { ledger } : {}),
    })
  );
  const authLayer = Layer.succeed(Authorization.AuthPolicy)(authPolicy(resources));

  const serverLayer = SyncRoom.layer.pipe(Layer.provide(backendLayer), Layer.provide(authLayer));
  const transportLayer = Transport.layerInMemory(options.clientGroupId).pipe(
    Layer.provide(serverLayer)
  );

  // Interval pull is now a core sync-loop concern (default 5s, opt-out with
  // `null`); no bespoke poll loop in `start`.
  const pullInterval =
    options.pullInterval === null ? undefined : (options.pullInterval ?? Duration.seconds(5));
  const syncLoop: ClientEngine.SyncLoopOptions = {
    ...(pullInterval !== undefined ? { pullInterval } : {}),
    ...(options.pushDebounce !== undefined ? { pushDebounce: options.pushDebounce } : {}),
  };

  return ClientEngine.layer({
    clientId: options.clientId,
    clientGroupId: options.clientGroupId,
    mutators: registry,
    syncLoop,
  }).pipe(Layer.provide(transportLayer), Layer.provide(options.store ?? ClientStore.layerMemory));
};

/**
 * Start syncing: run the engine's sync loop. Interval pull, push-on-mutate,
 * pull-on-poke and push+pull-on-reconnect are all scheduled by the core loop
 * (configure the interval/debounce on `layer`'s options). Requires a `Scope` —
 * fork it into the app's runtime and the fibers live until the scope closes.
 */
export const start: Effect.Effect<void, never, ClientEngine.ClientEngine | Scope.Scope> =
  Effect.gen(function* () {
    const engine = yield* ClientEngine.ClientEngine;
    // Forking never surfaces the loop's errors; die on the impossible.
    yield* engine.runSync.pipe(Effect.orDie);
  });
