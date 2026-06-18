/**
 * @thomasfosterau/effect-sync-core
 *
 * The Effect-native sync engine (v2 architecture, ADRs 0007–0010):
 * mutation-log writes with server-authoritative rebase, CVR state patches
 * downstream, typed collections with re-run live queries, and a
 * customisable schema-message protocol.
 *
 * - **Shared model**: collections, predicates, subsets, mutators, errors
 * - **Protocol**: push/pull/poke messages and patch operations
 * - **Client**: durable store, optimistic engine with journal + rebase
 * - **Server**: BYO backend contract, auth filters + middleware, CVR
 *   bookkeeping, invalidation bus, sync rooms
 * - **HTTP cache**: the separate service-worker Request/Response cache
 *
 * Runtime adapters (service-worker host, IndexedDB store, Durable Object
 * rooms) live in the runtime packages.
 */

// ─── Shared model ────────────────────────────────────────────────────────────
export * from "./Errors.js";
export * as Collection from "./Collection.js";
export * as Predicate from "./Predicate.js";
export * as Subset from "./Subset.js";
export * as Mutator from "./Mutator.js";
export * as Query from "./Query.js";
export * as Hash from "./Hash.js";

// ─── Protocol ────────────────────────────────────────────────────────────────
export * as Protocol from "./Protocol.js";
export * as Transport from "./Transport.js";
export * as RpcTransport from "./RpcTransport.js";

// ─── Client ──────────────────────────────────────────────────────────────────
export * as ClientStore from "./ClientStore.js";
export * as ClientEngine from "./ClientEngine.js";
export * as LiveView from "./LiveView.js";
export * as Subscriptions from "./Subscriptions.js";
export * as LiveQuery from "./LiveQuery.js";
export * as PromiseFacade from "./PromiseFacade.js";

// ─── Server ──────────────────────────────────────────────────────────────────
export * as Backend from "./Backend.js";
export * as BackendContract from "./BackendContract.js";
export * as MemoryBackend from "./MemoryBackend.js";
export * as Authorization from "./Authorization.js";
export * as Cvr from "./Cvr.js";
export * as InvalidationBus from "./InvalidationBus.js";
export * as BusBrokers from "./BusBrokers.js";
export * as SyncServer from "./SyncServer.js";
export * as SyncRoom from "./SyncRoom.js";
export * as Telemetry from "./Telemetry.js";

// ─── HTTP cache ──────────────────────────────────────────────────────────────
export * as HttpCache from "./HttpCache.js";
