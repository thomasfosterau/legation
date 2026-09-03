/**
 * @legation/effect
 *
 * An offline-first sync engine around six concepts (ADR-0022):
 *
 * - {@link Node} / {@link Edge} — the resource graph: typed attributes plus
 *   `one`/`many`/`paginated` edges, each foreign key declared exactly once.
 * - {@link Collection} — the named set of one Node type the client
 *   materializes (derived from the graph by `Node.registry`).
 * - {@link Query} — THE read: declarative, compiled to a plan of sync
 *   windows; named queries are the same concept with a name and args.
 * - {@link Mutation} — the write: a named, schema-validated intent executed
 *   optimistically on the Client and authoritatively on the Backend.
 * - {@link Client} — the one-per-thread object; where a read is answered
 *   (replica, worker-hosted engine, server fallthrough) is configuration.
 * - {@link Hydration} — moving a client's durable state across a
 *   serialisation boundary: the SSR snapshot a server renders and a browser
 *   hydrates, framework-agnostically.
 * - {@link Server} — one per backend: the protocol handler plus
 *   `broadcast`, the single verb for out-of-band changes.
 *
 * Supporting surface: {@link Backend} (the BYO storage contract) with
 * {@link MemoryBackend} for tests and prototypes; {@link Authorization}
 * (deny-by-default per-collection filters, expressed as
 * {@link Predicate}s); {@link Aggregate} projections; {@link ClientStore}
 * and {@link Transport} (the persistence and carrier seams a Client is
 * wired with); and the typed error classes.
 *
 * Implementation seams — the engine, the mirror machinery, protocol
 * codecs, server assembly — live behind `@legation/effect/internal` for
 * adapter authors and the sibling `@legation/*` packages.
 */

// ─── The resource graph ──────────────────────────────────────────────────────
export * as Node from "./Node.js";
export * as Edge from "./Edge.js";
export * as Collection from "./Collection.js";

// ─── Reads and writes ────────────────────────────────────────────────────────
export * as Query from "./Query.js";
export * as Aggregate from "./Aggregate.js";
export * as Mutation from "./Mutator.js";
/** @deprecated The write concept is {@link Mutation} (ADR-0022). */
export * as Mutator from "./Mutator.js";

// ─── Client ──────────────────────────────────────────────────────────────────
export * as Client from "./Client.js";
export * as ClientStore from "./ClientStore.js";
export * as Transport from "./Transport.js";
export * as Hydration from "./Hydration.js";

// ─── Server ──────────────────────────────────────────────────────────────────
export * as Server from "./Server.js";
export * as Backend from "./Backend.js";
export * as MemoryBackend from "./MemoryBackend.js";
export * as Authorization from "./Authorization.js";
export * as FilterPolicy from "./FilterPolicy.js";
export * as Predicate from "./Predicate.js";

// ─── Errors ──────────────────────────────────────────────────────────────────
export * from "./Errors.js";
