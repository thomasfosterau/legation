/**
 * Hydration
 *
 * Move a client's durable state across a serialisation boundary: `dehydrate`
 * reads a {@link ClientStore} into a plain {@link Snapshot}; `hydrate` writes a
 * snapshot back into a store. Between the two the snapshot is JSON — the value
 * an SSR response embeds, a devtools export writes to disk, or a client hands to a
 * worker.
 *
 * ## SSR flow
 *
 * The server renders a page over a *real* engine per request: an in-memory
 * {@link ClientStore} plus a {@link ClientTransport} to the sync server. It
 * `subscribe`s the subsets the page needs, `pull`s once, then `dehydrate`s the
 * store — capturing the confirmed rows, the pull cookie, and any journalled
 * mutations. That snapshot ships to the browser (JSON-encoded in the document).
 * The client builds its durable store, `hydrate`s the snapshot into it, and
 * constructs the engine over that store. The first render already has rows (no
 * loading flash), and because the cookie came across too the client's first
 * pull continues the CVR conversation from where the server left off — no
 * refetch of state the server already sent.
 *
 * The transport is the seam that makes this work off-process. Pull is the
 * correctness path, so subscribe → pull → dehydrate behaves identically
 * against a remote Server: the renderer need not hold the backend. A
 * single-process app passes nothing and gets a loop-back transport over the
 * in-context {@link ServerHandler}; a split deployment (a SvelteKit Worker
 * rendering against a separate API Worker) passes its own carrier.
 *
 * ## Seeded-versions caveat
 *
 * A snapshot carries each row's authoritative `version`. Those versions must be
 * genuine backend versions for CVR diffing to converge cheaply on the next
 * pull: the server compares them against its record and sends only the delta.
 * Self-invented versions are *safe* — they never corrupt state — but they will
 * not match the server's CVR, so the next pull degrades to the reset path (the
 * server sends a `Clear` followed by full puts). The same caveat applies to
 * {@link ClientEngine.seed}.
 *
 * ## Validation
 *
 * `hydrate` decodes the snapshot through {@link SnapshotSchema} before writing,
 * so a `dehydrate → JSON.stringify → JSON.parse → hydrate` round-trip is
 * schema-checked end to end; a malformed snapshot fails as a `StoreError`.
 * Only the *envelopes* are validated — row values and mutation args stay
 * `Unknown` and round-trip untouched (ADR-0014), exactly like the store's own
 * persisted codecs. Use {@link SnapshotFromJson} to fold the JSON step into the
 * decode.
 */

import { Effect, Schema } from "effect";
import * as ClientEngineModule from "./ClientEngine.js";
import { ClientStore, freezePending, makeMemory, StoredRowSchema } from "./ClientStore.js";
import type { MutatorError, TransportError, VersionNotSupportedError } from "./Errors.js";
import { StoreError } from "./Errors.js";
import * as Mutator from "./Mutator.js";
import type * as Node from "./Node.js";
import { MutationSchema } from "./Protocol.js";
import * as Query from "./Query.js";
import * as Subset from "./Subset.js";
import { ClientTransport, makeInMemory, ServerHandler } from "./Transport.js";

/**
 * One dehydrated row: a {@link StoredRow} tagged with the collection it belongs
 * to, so the flat `rows` array reconstructs the per-collection layout on
 * hydrate. `value` stays `Unknown` (envelope-validated only, ADR-0014).
 */
export const SnapshotRowSchema = Schema.Struct({
  collection: Schema.String,
  ...StoredRowSchema.fields,
});

/**
 * A serialisable capture of a {@link ClientStore}: confirmed rows (flattened
 * with their collection), the pull cookie, the pending-mutation journal, and
 * the acknowledged-but-unpulled tail (#336). The tail is optional so a
 * snapshot taken before it existed still loads, as an empty tail. The schema
 * is the source of truth; {@link Snapshot} is derived from it.
 */
export const SnapshotSchema = Schema.Struct({
  rows: Schema.Array(SnapshotRowSchema),
  cookie: Schema.optional(Schema.String),
  journal: Schema.Array(MutationSchema),
  unpulled: Schema.optional(Schema.Array(MutationSchema)),
});

/** {@inheritDoc SnapshotSchema} */
export type Snapshot = typeof SnapshotSchema.Type;

/** {@inheritDoc SnapshotRowSchema} */
export type SnapshotRow = typeof SnapshotRowSchema.Type;

/**
 * JSON codec for a {@link Snapshot}: `decode` parses a JSON string and validates
 * it in one step (SSR/devtools ingest), `encode` produces the JSON string.
 */
export const SnapshotFromJson = Schema.fromJsonString(SnapshotSchema);

const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });

/**
 * Read a {@link ClientStore} into a {@link Snapshot}: enumerate the collections,
 * gather their confirmed rows (flattened with the collection), the cookie, the
 * journal, and the unpulled tail. The tail is left out when empty, so a
 * snapshot without one keeps its previous shape.
 */
export const dehydrate = (store: ClientStore): Effect.Effect<Snapshot, StoreError> =>
  Effect.gen(function* () {
    const rows: Array<SnapshotRow> = [];
    for (const collection of yield* store.listCollections) {
      for (const row of yield* store.listRows(collection)) {
        rows.push({ collection, id: row.id, version: row.version, value: row.value });
      }
    }
    const cookie = yield* store.getCookie;
    const journal = yield* store.pendingMutations;
    const unpulled = yield* store.unpulled;
    return {
      rows,
      ...(cookie !== undefined ? { cookie } : {}),
      journal,
      ...(unpulled.length > 0 ? { unpulled } : {}),
    };
  });

/**
 * Write a {@link Snapshot} into a {@link ClientStore}: validate it through
 * {@link SnapshotSchema} (so a malformed snapshot fails as a `StoreError`), then
 * put the rows, set the cookie if present, park the unpulled tail, and append
 * the journal in order. A snapshot without a tail parks nothing.
 *
 * A running {@link ClientEngine} built over the store re-reads its view and built
 * indexes afterwards: a direct write does not go through the engine, so without this
 * an indexed query could return a row whose indexed field changed (#350). The re-read
 * runs when a write fails too, since the rows written before the failure are in the
 * store. It reaches only the engines built over this exact store object: a store
 * wrapped in a new object (`ClientStore.of({ ...store })`) is not seen, so its engine
 * can stay stale. The same re-read tracks the appended journal entries in its
 * `mutationStates` as `"pending"` (#358), so they settle like a local mutation. Journal ids
 * should be ids this client has not already settled: an id the map has evicted is tracked again,
 * and its outcome event can then follow a second time.
 *
 * The writes are not atomic. Between the first `putRow` and the re-read, an indexed
 * read on an async store can see the old index against the new rows. Once `hydrate`
 * returns or fails, the engine's view and indexes match the store again.
 */
export const hydrate = (store: ClientStore, snapshot: Snapshot): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SnapshotSchema)(snapshot).pipe(
      Effect.mapError(storeError("Invalid snapshot"))
    );
    yield* Effect.gen(function* () {
      for (const { collection, ...row } of decoded.rows) {
        yield* store.putRow(collection, row);
      }
      if (decoded.cookie !== undefined) yield* store.setCookie(decoded.cookie);
      // The tail's effects are already in the rows, and the next pull releases it (#336).
      if (decoded.unpulled !== undefined) yield* store.parkUnpulled(decoded.unpulled);
      // `dehydrate` reads the journal and the tail in two calls, so a push acknowledgement
      // between them puts an entry in both. The tail copy wins: it is not journaled again (#387).
      const parked = new Set(
        (decoded.unpulled ?? []).map((m) => `${m.clientId}\u0000${m.mutationId}`)
      );
      for (const mutation of decoded.journal) {
        if (parked.has(`${mutation.clientId}\u0000${mutation.mutationId}`)) continue;
        yield* store.appendMutation(mutation);
      }
      // These entries came from another context: whether they were pushed there
      // is unknowable here, so paced compaction must not renumber them (#249).
      yield* freezePending(store);
    }).pipe(
      // A refused write leaves the rows before it in the store, so the re-read
      // runs on failure too (#350).
      Effect.ensuring(ClientEngineModule.resyncAttachedEngines(store))
    );
  });

/**
 * Whether a store holds nothing: no rows, no cookie, no journalled or unpulled mutations.
 * The "fresh browser" test {@link hydrateIfEmpty} gates on.
 */
export const isEmpty = (store: ClientStore): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    if ((yield* store.getCookie) !== undefined) return false;
    if ((yield* store.pendingMutations).length > 0) return false;
    if ((yield* store.unpulled).length > 0) return false;
    for (const collection of yield* store.listCollections) {
      if ((yield* store.listRows(collection)).length > 0) return false;
    }
    return true;
  });

/**
 * {@link hydrate}, but only into an empty store; returns whether it hydrated.
 *
 * This is the right client-boot default over a *durable* store: on a repeat
 * visit the store already holds rows, a cookie, and possibly journalled
 * offline mutations that are all fresher than the SSR snapshot — hydrating
 * over them would regress the cookie (and with it the CVR conversation) and
 * clobber newer confirmed rows. An empty store (first visit, cleared storage)
 * takes the snapshot wholesale.
 */
export const hydrateIfEmpty = (
  store: ClientStore,
  snapshot: Snapshot
): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    if (!(yield* isEmpty(store))) return false;
    yield* hydrate(store, snapshot);
    return true;
  });

/**
 * Project a snapshot onto a read, locally and synchronously: the snapshot's
 * rows for the read's collection, filtered/sorted/windowed by the read's
 * compiled root window. This is how a component derives its initial value
 * (e.g. the rune hooks' `initial` option) from the page's snapshot — during
 * SSR and on first client render — without touching an engine.
 *
 * `include`d edges are not resolved here: a snapshot is flat rows, and
 * resolving edges is the Client's job once the engine is up. Seed the base
 * rows and let the first live emission fill the edges in.
 */
export const rowsFor = (
  snapshot: Snapshot,
  nodes: Node.NodeRegistry,
  read: Query.Read
): ReadonlyArray<ClientEngineModule.LocalRow> =>
  Subset.apply(
    snapshot.rows
      .filter((row) => row.collection === read.collection)
      .map((row) => ({ id: row.id, value: row.value })),
    Query.plan(nodes, read).root
  );

/** Options for {@link snapshot}. */
export interface SnapshotOptions {
  /**
   * The client group the render belongs to — the browser's group id (e.g.
   * carried in an HTTP cookie), so the cookie in the produced snapshot
   * continues that group's CVR conversation on the client's first pull.
   */
  readonly clientGroupId: string;
  /** Client id for the request-scoped engine (never pushes). Default `"ssr"`. */
  readonly clientId?: string;
  /** The node graph the reads compile against. */
  readonly nodes: Node.NodeRegistry;
  /** The reads the page needs — subscribed and pulled once. */
  readonly reads: ReadonlyArray<Query.Read>;
  /** Mutation registry for the request-scoped engine. Default: none. */
  readonly mutations?: Mutator.MutatorRegistry;
  /**
   * The carrier the request-scoped engine pulls over. Omit it for the
   * in-process default — a loop-back transport to the in-context
   * {@link ServerHandler} — which is what a single-process app wants.
   *
   * Pass one when the renderer is *not* the process holding the backend: a
   * SvelteKit Worker rendering against a separate API Worker, an SSR tier in
   * front of a remote sync server. Whatever the carrier, it must preserve the
   * CVR conversation end to end — the request's `clientGroupId` reaches the
   * Server unchanged, and the Server's fresh cookie comes back in the pull
   * response — or the snapshot's cookie belongs to a conversation the client
   * is not in, and its first pull silently degrades to the reset path.
   */
  readonly transport?: ClientTransport;
}

/** {@link SnapshotOptions} with the carrier supplied — no `ServerHandler` needed. */
export interface RemoteSnapshotOptions extends SnapshotOptions {
  readonly transport: ClientTransport;
}

/** What a snapshot render can fail with. */
export type SnapshotError = StoreError | TransportError | MutatorError | VersionNotSupportedError;

/** The snapshot render itself, over an already-built carrier. */
const renderOver = (
  transport: ClientTransport,
  options: SnapshotOptions
): Effect.Effect<Snapshot, SnapshotError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* makeMemory;
      const engine = yield* ClientEngineModule.make({
        clientId: options.clientId ?? "ssr",
        clientGroupId: options.clientGroupId,
        mutators: options.mutations ?? Mutator.registry([]),
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
      for (const read of options.reads) {
        yield* engine.subscribe(Query.plan(options.nodes, read).root);
      }
      yield* engine.pull;
      return yield* dehydrate(store);
    })
  );

/**
 * Produce an SSR snapshot over a request-scoped engine: build an in-memory
 * {@link ClientStore}, subscribe the page's subsets over the given
 * {@link ClientTransport}, pull once, and {@link dehydrate}. Everything is
 * scoped to the call — nothing outlives it.
 *
 * With `options.transport` the render needs nothing from context; without it
 * the in-process path applies and the app's sync server is taken from context
 * as `ServerHandler`, carried by a loop-back transport.
 *
 * This is the server half of the SSR flow described above; run it inside a
 * request handler (a SvelteKit `load`, a Next.js loader). Framework packages
 * wrap this — they add the framework's own plumbing (a cookie, a `load`
 * signature), never their own hydration logic.
 */
export function snapshot(options: RemoteSnapshotOptions): Effect.Effect<Snapshot, SnapshotError>;
/** The in-process form: renders against the app's sync server, the `ServerHandler` in context. */
export function snapshot(
  options: SnapshotOptions
): Effect.Effect<Snapshot, SnapshotError, ServerHandler>;
export function snapshot(
  options: SnapshotOptions
): Effect.Effect<Snapshot, SnapshotError, ServerHandler> {
  const supplied = options.transport;
  if (supplied !== undefined) return renderOver(supplied, options);
  return Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* ServerHandler;
      const transport = yield* makeInMemory(handler, options.clientGroupId);
      return yield* renderOver(transport, options);
    })
  );
}
