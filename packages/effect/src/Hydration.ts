/**
 * Hydration
 *
 * Move a client's durable state across a serialisation boundary: `dehydrate`
 * reads a {@link ClientStore} into a plain {@link Snapshot}; `hydrate` writes a
 * snapshot back into a store. Between the two the snapshot is JSON — the value
 * an SSR response embeds, a devtools export writes to disk, or a tab hands to a
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
import { StoredRowSchema, type ClientStore } from "./ClientStore.js";
import { StoreError } from "./Errors.js";
import { MutationSchema } from "./Protocol.js";

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
