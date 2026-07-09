/**
 * @legation/effect/internal
 *
 * The implementation seams behind the public surface (ADR-0022): the
 * engine, the mirror machinery, the plan vocabulary, protocol codecs,
 * reactivity plumbing, and server assembly parts. Everything here is
 * tested and documented for contributors and adapter authors — the sibling
 * `@legation/*` packages compose from this entrypoint — but it is not the
 * app-facing API and moves faster than the root surface.
 */

// ─── Plan vocabulary (compiled from Query reads) ─────────────────────────────
export * as Subset from "./Subset.js";
export * as Related from "./Related.js";
export * as Hash from "./Hash.js";

// ─── Protocol ────────────────────────────────────────────────────────────────
export * as Protocol from "./Protocol.js";
export * as RpcTransport from "./RpcTransport.js";
export * as SpecExport from "./SpecExport.js";

// ─── Engine ──────────────────────────────────────────────────────────────────
export * as ClientEngine from "./ClientEngine.js";
export * as ClientView from "./ClientView.js";
export * as Undo from "./Undo.js";
export * as Introspection from "./Introspection.js";
export * as Hydration from "./Hydration.js";
export * as LiveView from "./LiveView.js";
export * as OrderedTree from "./OrderedTree.js";
export * as FractionalIndex from "./FractionalIndex.js";
export * as Subscriptions from "./Subscriptions.js";
export * as LiveQuery from "./LiveQuery.js";
export * as EngineAtoms from "./EngineAtoms.js";
export * as PromiseFacade from "./PromiseFacade.js";

// ─── Mirror seam (ADR-0010/0021) ─────────────────────────────────────────────
export * as MirrorProtocol from "./MirrorProtocol.js";
export * as MirrorChannel from "./MirrorChannel.js";
export * as EngineHost from "./EngineHost.js";
export * as Mirror from "./Mirror.js";

// ─── Server assembly ─────────────────────────────────────────────────────────
export * as BackendContract from "./BackendContract.js";
export * as Cvr from "./Cvr.js";
export * as InvalidationBus from "./InvalidationBus.js";
export * as FanoutTopics from "./FanoutTopics.js";
export * as FanoutBroker from "./FanoutBroker.js";
export * as FanoutBus from "./FanoutBus.js";
export * as BusBrokers from "./BusBrokers.js";
export * as HintSource from "./HintSource.js";
export * as SyncServer from "./SyncServer.js";
export * as SyncRoom from "./SyncRoom.js";
export * as Telemetry from "./Telemetry.js";

// ─── HTTP cache ──────────────────────────────────────────────────────────────
export * as HttpCache from "./HttpCache.js";
