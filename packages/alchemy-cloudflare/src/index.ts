/**
 * @thomasfosterau/legation-alchemy-cloudflare
 *
 * The Cloudflare Workers reference topology (ADR-0022, ADR-0023), built on
 * Alchemy's Effect-native Cloudflare provider (ADR-0034):
 *
 * - a stateless Worker router ({@link Worker.routeSync}) forwarding the
 *   sync routes to the caller's per-user room;
 * - the **room** Durable Object ({@link Room.make}): the sync `Server` for
 *   one user — HTTP push/pull/read, CVRs in DO storage, hibernation-friendly
 *   WebSockets carrying contentless pokes;
 * - the **fan-out shard** Durable Object ({@link FanoutShard.make}): one
 *   object per topic, holding leased room registrations — ADR-0023's broker,
 *   platform-sharded;
 * - {@link D1Executor}: `SqlBackend`'s executor over Alchemy's D1 client;
 * - {@link RoomTransport}: the browser-side `ClientTransport` for this
 *   topology (HTTP requests + poke socket);
 * - {@link BindingTransport}: the same protocol over a **service binding**
 *   (`env.API.fetch`) — what an SSR render in a separate Worker uses to take
 *   a `Hydration.snapshot` against a binding-only API Worker;
 * - {@link EdgeInvalidation}: KV and edge-cache eviction from a write's hints.
 *
 * The app declares its Durable Object classes and binds this package's
 * implementations to them (`LegationRoom.make(Room.make(...))`,
 * `LegationShard.make(FanoutShard.make)`).
 */

export * as BindingTransport from "./BindingTransport.js";
export * as D1Executor from "./D1Executor.js";
export * as DurableCvrStore from "./DurableCvrStore.js";
export * as DurableFanoutBroker from "./DurableFanoutBroker.js";
export * as EdgeInvalidation from "./EdgeInvalidation.js";
export * as FanoutShard from "./FanoutShard.js";
export * as Room from "./Room.js";
export * as RoomProtocol from "./RoomProtocol.js";
export * as RoomTransport from "./RoomTransport.js";
export * as Worker from "./Worker.js";
