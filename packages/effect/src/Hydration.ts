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
 * {@link ClientStore} plus an in-process transport to the sync server. It
 * `subscribe`s the subsets the page needs, `pull`s once, then `dehydrate`s the
 * store — capturing the confirmed rows, the pull cookie, and any journalled
 * mutations. That snapshot ships to the browser (JSON-encoded in the document).
 * The client builds its durable store, `hydrate`s the snapshot into it, and
 * constructs the engine over that store. The first render already has rows (no
 * loading flash), and because the cookie came across too the client's first
 * pull continues the CVR conversation from where the server left off — no
 * refetch of state the server already sent.
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
import { ClientStore, makeMemory, StoredRowSchema } from "./ClientStore.js";
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
 * with their collection), the pull cookie, and the pending-mutation journal.
 * The schema is the source of truth; {@link Snapshot} is derived from it.
 */
export const SnapshotSchema = Schema.Struct({
  rows: Schema.Array(SnapshotRowSchema),
  cookie: Schema.optional(Schema.String),
  journal: Schema.Array(MutationSchema),
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
 * gather their confirmed rows (flattened with the collection), the cookie, and
 * the journal.
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
    return { rows, ...(cookie !== undefined ? { cookie } : {}), journal };
  });

/**
 * Write a {@link Snapshot} into a {@link ClientStore}: validate it through
 * {@link SnapshotSchema} (so a malformed snapshot fails as a `StoreError`), then
 * put the rows, set the cookie if present, and append the journal in order.
 */
export const hydrate = (store: ClientStore, snapshot: Snapshot): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SnapshotSchema)(snapshot).pipe(
      Effect.mapError(storeError("Invalid snapshot"))
    );
    for (const { collection, ...row } of decoded.rows) {
      yield* store.putRow(collection, row);
    }
    if (decoded.cookie !== undefined) yield* store.setCookie(decoded.cookie);
    for (const mutation of decoded.journal) {
      yield* store.appendMutation(mutation);
    }
  });

/**
 * Whether a store holds nothing: no rows, no cookie, no journalled mutations.
 * The "fresh browser" test {@link hydrateIfEmpty} gates on.
 */
export const isEmpty = (store: ClientStore): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    if ((yield* store.getCookie) !== undefined) return false;
    if ((yield* store.pendingMutations).length > 0) return false;
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
}

/**
 * Produce an SSR snapshot over a request-scoped engine: build an in-memory
 * {@link ClientStore} and an in-process transport to the in-context
 * {@link ServerHandler}, subscribe the page's subsets, pull once, and
 * {@link dehydrate}. Everything is scoped to the call — nothing outlives it.
 *
 * This is the server half of the SSR flow described above; run it inside a
 * request handler (a SvelteKit `load`, a Next.js loader) with the app's sync
 * server provided as `ServerHandler`. Framework packages wrap this — they add
 * the framework's own plumbing (a cookie, a `load` signature), never their own
 * hydration logic.
 */
export const snapshot = (
  options: SnapshotOptions
): Effect.Effect<
  Snapshot,
  StoreError | TransportError | MutatorError | VersionNotSupportedError,
  ServerHandler
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* ServerHandler;
      const store = yield* makeMemory;
      const transport = yield* makeInMemory(handler, options.clientGroupId);
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
