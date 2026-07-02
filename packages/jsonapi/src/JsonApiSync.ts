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
 */

import { Duration, Effect, Layer, Scope } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  SyncRoom,
  Transport,
} from "@legation/effect";
import { reflectResources, type ResourceMap } from "./Convention.js";
import { derive, type Derived } from "./Derive.js";
import * as JsonApiBackend from "./JsonApiBackend.js";
import type { QueryEncoder } from "./JsonApiQuery.js";

/** An app's JSON:API surface defined with Effect `HttpApi`. */
export type JsonApi = HttpApi.HttpApi<string, HttpApiGroup.Any>;

export interface JsonApiSyncOptions {
  /** Base URL the resource paths resolve against (no trailing slash). */
  readonly baseUrl: string;
  /** This client's id (stable per device/tab). */
  readonly clientId: string;
  /** The client group this client belongs to (shared journal scope). */
  readonly clientGroupId: string;
  /** Override the Subset → JSON:API query encoding (e.g. your own package). */
  readonly queryEncoder?: QueryEncoder;
  /**
   * Relationship names to compound-load per collection (`?include=...`), so
   * `Relationships.related` resolves them without extra round trips.
   */
  readonly includes?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** Reflect + derive an api's resources, collections, mutators, operations. */
export const inspect = (api: JsonApi): { readonly resources: ResourceMap } & Derived => {
  const resources = reflectResources(api);
  return { resources, ...derive(resources) };
};

/** Every resource collection is readable; the REST API enforces real auth. */
const authPolicy = (resources: ResourceMap): Authorization.AuthPolicy =>
  Authorization.policy(
    Object.fromEntries([...resources.keys()].map((type) => [type, Authorization.allowAll]))
  );

/**
 * The full client-direct stack as a layer: provide an `HttpClient`, get a
 * ready `ClientEngine`. CVR store and invalidation bus are in-process; the
 * client store is in-memory (swap in a durable `ClientStore` layer for
 * offline persistence across reloads).
 */
export const layer = (
  api: JsonApi,
  options: JsonApiSyncOptions
): Layer.Layer<ClientEngine.ClientEngine, never, HttpClient.HttpClient> => {
  const { resources, registry, operations } = inspect(api);

  const backendLayer = Layer.effect(Backend.Backend)(
    JsonApiBackend.make({
      baseUrl: options.baseUrl,
      resources,
      mutators: registry.mutators,
      operations,
      ...(options.queryEncoder !== undefined ? { query: options.queryEncoder } : {}),
      ...(options.includes !== undefined ? { includes: options.includes } : {}),
    })
  );
  const authLayer = Layer.succeed(Authorization.AuthPolicy)(authPolicy(resources));

  const serverLayer = SyncRoom.layer.pipe(Layer.provide(backendLayer), Layer.provide(authLayer));
  const transportLayer = Transport.layerInMemory(options.clientGroupId).pipe(
    Layer.provide(serverLayer)
  );

  return ClientEngine.layer({
    clientId: options.clientId,
    clientGroupId: options.clientGroupId,
    mutators: registry,
  }).pipe(Layer.provide(transportLayer), Layer.provide(ClientStore.layerMemory));
};

/**
 * Start syncing: run the engine's sync loop (pull on poke from local writes;
 * push+pull on connect) and poll for changes made elsewhere. Requires a
 * `Scope` — fork it into the app's runtime and the fibers live until the
 * scope closes.
 */
export const start = (options?: {
  readonly pollInterval?: Duration.Duration;
}): Effect.Effect<void, never, ClientEngine.ClientEngine | Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* ClientEngine.ClientEngine;
    // Forking never surfaces the loop's errors; die on the impossible.
    yield* engine.runSync.pipe(Effect.orDie);
    const interval = options?.pollInterval ?? Duration.seconds(5);
    yield* Effect.forkScoped(
      Effect.forever(Effect.ignore(engine.pull).pipe(Effect.delay(interval)))
    );
  });
