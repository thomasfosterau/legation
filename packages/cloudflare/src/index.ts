/**
 * @legation/cloudflare
 *
 * The Cloudflare Workers reference topology (ADR-0022, ADR-0023):
 *
 * - a stateless Worker router ({@link Worker.routeSync}) forwarding the
 *   sync routes to the caller's per-user room;
 * - the **room** Durable Object ({@link Room.makeRoomClass}): the sync
 *   `Server` for one user — HTTP push/pull/read, CVRs in DO storage,
 *   hibernation-friendly WebSockets carrying contentless pokes;
 * - the **fan-out shard** Durable Object ({@link FanoutShard.makeShardClass}):
 *   one object per topic, holding leased room registrations and poking
 *   rooms on publish — ADR-0023's broker, platform-sharded;
 * - {@link D1Executor}: `SqlBackend` over a D1 binding;
 * - {@link RoomTransport}: the browser-side `ClientTransport` for this
 *   topology (HTTP requests + poke socket).
 */

export * as D1Executor from "./D1Executor.js";
export * as DurableCvrStore from "./DurableCvrStore.js";
export * as DurableFanoutBroker from "./DurableFanoutBroker.js";
export * as FanoutShard from "./FanoutShard.js";
export * as Room from "./Room.js";
export * as RoomProtocol from "./RoomProtocol.js";
export * as RoomTransport from "./RoomTransport.js";
export * as Worker from "./Worker.js";
