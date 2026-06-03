/**
 * @thomasfosterau/effect-sync-core
 *
 * The Effect-native sync engine. Everything that can be implemented with a
 * dependency on `effect` alone lives in this package:
 *
 * - **Primitives**: sync keys, cache stores, the write-through cache
 *   engine, queries, pagination, mutations, the outbox, the sync protocol,
 *   transports, and conflict resolution
 * - **Client**: a TanStack-Query-style query/mutation/subscription manager
 *   and an offline-capable sync client
 * - **Cache engine**: write-through HTTP and data caching for service
 *   workers and edge runtimes, with pluggable persistence
 * - **Server**: a write-through sync hub that fans out updates to
 *   subscribed clients
 * - **Facades**: promise/callback wrappers for non-Effect consumers
 *
 * Protocol adapters (e.g. `@thomasfosterau/effect-sync-jsonapi`) live in
 * separate packages.
 */

// ─── Primitives ─────────────────────────────────────────────────────────────
export * as SyncKey from "./SyncKey.js";
export * from "./Errors.js";
export * as Versioned from "./Versioned.js";
export * from "./CacheStore.js";
export * as MemoryCacheStore from "./MemoryCacheStore.js";
export * as SyncCache from "./SyncCache.js";
export * as Query from "./Query.js";
export * as Pagination from "./Pagination.js";
export * as Mutation from "./Mutation.js";
export * as Outbox from "./Outbox.js";
export * as Protocol from "./Protocol.js";
export * as ProtocolSchema from "./ProtocolSchema.js";
export * as Transport from "./Transport.js";
export * as PromiseFacade from "./PromiseFacade.js";

// ─── Client: queries, mutations, subscriptions, offline sync ────────────────
export * as QueryClient from "./QueryClient.js";
export * as MutationState from "./MutationState.js";
export * as Subscriptions from "./Subscriptions.js";
export * as SyncClient from "./SyncClient.js";
export * as ClientFacade from "./ClientFacade.js";

// ─── Cache engine: service workers and edge runtimes ────────────────────────
export * as WriteThroughCache from "./WriteThroughCache.js";
export * as HttpCache from "./HttpCache.js";
export * as KeyValueStoreAdapter from "./KeyValueStoreAdapter.js";

// ─── Server: write-through sync hub with fan-out ────────────────────────────
export * as ServerStore from "./ServerStore.js";
export * as Sessions from "./Sessions.js";
export * as SyncHub from "./SyncHub.js";
export * as ServerFacade from "./ServerFacade.js";
