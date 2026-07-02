/**
 * ClientStore
 *
 * The client's durable state: confirmed rows per collection, the journal of
 * pending mutations, and the pull cookie. Every engine state transition is
 * persisted here so a killed host (notably a service worker, ADR-0010)
 * rehydrates losslessly.
 *
 * Rows stored here are *confirmed* (authoritative) state only; optimistic
 * effects live in the overlay and are recomputed by replay, never persisted
 * as rows.
 */

import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import type { RowId } from "./Collection.js";
import { StoreError } from "./Errors.js";
import { MutationSchema, type Mutation, type PatchOp } from "./Protocol.js";

/**
 * A confirmed row as persisted: encoded value + authoritative version. The
 * schema validates the row *envelope* on read; `value` stays `Unknown` and
 * is carried through untouched, so additive schema changes round-trip
 * (ADR-0014: the engine never decodes row values on the read path).
 */
export const StoredRowSchema = Schema.Struct({
  id: Schema.String,
  version: Schema.Union([Schema.String, Schema.Number]),
  value: Schema.Unknown,
});

/** {@inheritDoc StoredRowSchema} */
export type StoredRow = typeof StoredRowSchema.Type;

export interface ClientStore {
  // Confirmed rows
  readonly getRow: (
    collection: string,
    id: RowId
  ) => Effect.Effect<StoredRow | undefined, StoreError>;
  readonly listRows: (collection: string) => Effect.Effect<ReadonlyArray<StoredRow>, StoreError>;
  /** Every collection that currently holds confirmed rows — the enumeration `dehydrate` walks. */
  readonly listCollections: Effect.Effect<ReadonlyArray<string>, StoreError>;
  readonly putRow: (collection: string, row: StoredRow) => Effect.Effect<void, StoreError>;
  readonly delRow: (collection: string, id: RowId) => Effect.Effect<void, StoreError>;
  readonly clearRows: Effect.Effect<void, StoreError>;
  /**
   * Apply a batch of patch ops (`Put`/`Del`/`Clear`) in one pass. Additive
   * bulk write for the pull path: grouping ops by collection lets the durable
   * store rewrite each touched collection's id-index at most once per batch —
   * so a K-op patch on a large collection writes K row values plus ~1 index per
   * collection, not the whole collection K times (#47). A `Clear` resets rows.
   */
  readonly applyRowOps: (ops: ReadonlyArray<PatchOp>) => Effect.Effect<void, StoreError>;

  // Journal
  readonly appendMutation: (mutation: Mutation) => Effect.Effect<void, StoreError>;
  readonly pendingMutations: Effect.Effect<ReadonlyArray<Mutation>, StoreError>;
  /** Drop journal entries with `mutationId <= upTo` for the client. */
  readonly acknowledge: (clientId: string, upTo: number) => Effect.Effect<void, StoreError>;
  readonly nextMutationId: (clientId: string) => Effect.Effect<number, StoreError>;

  // Sync bookkeeping
  readonly getCookie: Effect.Effect<string | undefined, StoreError>;
  readonly setCookie: (cookie: string) => Effect.Effect<void, StoreError>;
}

export const ClientStore = Context.Service<ClientStore>("@legation/effect/ClientStore");

/** In-memory implementation (tests, SSR, ephemeral clients). */
export const makeMemory: Effect.Effect<ClientStore> = Effect.gen(function* () {
  const rows = yield* Ref.make(new Map<string, Map<RowId, StoredRow>>());
  const journal = yield* Ref.make<ReadonlyArray<Mutation>>([]);
  const counters = yield* Ref.make(new Map<string, number>());
  const cookie = yield* Ref.make<string | undefined>(undefined);

  const collectionMap = (map: Map<string, Map<RowId, StoredRow>>, collection: string) =>
    map.get(collection) ?? new Map<RowId, StoredRow>();

  return ClientStore.of({
    getRow: (collection, id) => Ref.get(rows).pipe(Effect.map((m) => m.get(collection)?.get(id))),
    listRows: (collection) =>
      Ref.get(rows).pipe(Effect.map((m) => Array.from(collectionMap(m, collection).values()))),
    listCollections: Ref.get(rows).pipe(Effect.map((m) => Array.from(m.keys()))),
    putRow: (collection, row) =>
      Ref.update(rows, (m) => {
        const next = new Map(m);
        const c = new Map(collectionMap(m, collection));
        c.set(row.id, row);
        next.set(collection, c);
        return next;
      }),
    delRow: (collection, id) =>
      Ref.update(rows, (m) => {
        const next = new Map(m);
        const c = new Map(collectionMap(m, collection));
        c.delete(id);
        next.set(collection, c);
        return next;
      }),
    clearRows: Ref.set(rows, new Map()),
    applyRowOps: (ops) =>
      Ref.update(rows, (map) => {
        let next = map;
        for (const op of ops) {
          if (op._tag === "Clear") {
            next = new Map();
            continue;
          }
          const source = next === map ? new Map(map) : next;
          const c = new Map(collectionMap(source, op.collection));
          if (op._tag === "Put") c.set(op.id, { id: op.id, version: op.version, value: op.value });
          else c.delete(op.id);
          source.set(op.collection, c);
          next = source;
        }
        return next;
      }),

    appendMutation: (mutation) => Ref.update(journal, (entries) => entries.concat(mutation)),
    pendingMutations: Ref.get(journal),
    acknowledge: (clientId, upTo) =>
      Ref.update(journal, (entries) =>
        entries.filter((m) => m.clientId !== clientId || m.mutationId > upTo)
      ),
    nextMutationId: (clientId) =>
      Ref.modify(counters, (m) => {
        const next = (m.get(clientId) ?? 0) + 1;
        const updated = new Map(m);
        updated.set(clientId, next);
        return [next, updated];
      }),

    getCookie: Ref.get(cookie),
    setCookie: (value) => Ref.set(cookie, value),
  });
});

/** Layer providing the in-memory store. */
export const layerMemory: Layer.Layer<ClientStore> = Layer.effect(ClientStore)(makeMemory);

// ─── KeyValueStore-backed implementation ─────────────────────────────────────

export interface KeyValueOptions {
  /** Key namespace inside the KeyValueStore. Defaults to `"legation/"`. */
  readonly prefix?: string;
  /**
   * Maximum number of pending mutations the journal will hold. When an
   * `appendMutation` would exceed it, the append fails with a `StoreError`
   * rather than silently dropping the intent (#47) — the failure surfaces
   * through `mutate` so the app can block writes or warn. KVS-only: the memory
   * store is ephemeral and imposes no bound. Unset means unbounded.
   */
  readonly journalHighWater?: number;
  /**
   * Local store-version buster (#48). On open, if the persisted store-version
   * key differs from this value, the confirmed rows and the pull cookie are
   * cleared — so the next pull is a full reset ({@link Cvr} sends `Clear` + full
   * puts for the now-absent cookie) — and the new version is persisted. The
   * **pending journal is preserved**: a store-version bump is a local cache
   * buster, not a reason to drop the user's unsynced intents, so they still
   * push once the fresh rows land. Unset means no buster (today's behaviour).
   */
  readonly storeVersion?: string;
}

/**
 * The current durable layout version. Stamped at `__layout` on first open; a
 * store found at an earlier (or absent) version is migrated forward once (#47).
 */
const CURRENT_LAYOUT = "2";
const LAYOUT_KEY = "__layout";
/** Where the app-supplied {@link KeyValueOptions.storeVersion} is persisted (#48). */
const STORE_VERSION_KEY = "__storeVersion";

/** Per-row / per-mutation key builders (layout 2). */
const rowKey = (collection: string, id: string) => `row/${collection}/${id}`;
const rowIndexKey = (collection: string) => `rowIndex/${collection}`;
const journalBodyKey = (clientId: string, mutationId: number) =>
  `journal/${clientId}/${mutationId}`;
/** Legacy (layout 1) whole-collection / whole-journal blob keys. */
const legacyRowsKey = (collection: string) => `rows/${collection}`;
const LEGACY_JOURNAL_KEY = "journal";

/** An entry in the compact ordered journal index — ids only, never the body. */
const JournalIndexEntrySchema = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
});
type JournalIndexEntry = typeof JournalIndexEntrySchema.Type;

/** JSON codecs for the persisted values (envelope-validated on read). */
const RowFromJson = Schema.fromJsonString(StoredRowSchema);
const IdsFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
const CollectionsFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
const MutationFromJson = Schema.fromJsonString(MutationSchema);
const JournalIndexFromJson = Schema.fromJsonString(Schema.Array(JournalIndexEntrySchema));
const CountersFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number));
/** Legacy whole-blob codecs, read only on the migration / fallback path. */
const RowMapFromJson = Schema.fromJsonString(Schema.Record(Schema.String, StoredRowSchema));
const JournalFromJson = Schema.fromJsonString(Schema.Array(MutationSchema));

/** A batch of row ops grouped by collection: `null` marks a deletion. */
type RowChanges = Map<string, StoredRow | null>;
interface RowOpPlan {
  readonly clear: boolean;
  readonly groups: Map<string, RowChanges>;
}

/**
 * Fold a patch into a per-collection plan, so the durable path can rewrite each
 * touched collection once (a K-op patch → K row-value writes + ~1 index write
 * per collection, never the whole collection K times). A `Clear` wipes the plan
 * so far and marks the store for a reset before the surviving ops apply.
 */
const planRowOps = (ops: ReadonlyArray<PatchOp>): RowOpPlan => {
  const groups = new Map<string, RowChanges>();
  let clear = false;
  for (const op of ops) {
    if (op._tag === "Clear") {
      clear = true;
      groups.clear();
      continue;
    }
    const changes = groups.get(op.collection) ?? new Map();
    groups.set(op.collection, changes);
    changes.set(
      op.id,
      op._tag === "Put" ? { id: op.id, version: op.version, value: op.value } : null
    );
  }
  return { clear, groups };
};

/**
 * The durable implementation (ADR-0007): ClientStore over
 * `effect/unstable/persistence` KeyValueStore, so any platform KVS —
 * browser IndexedDB/localStorage, Node file system, SQL — persists the
 * engine.
 *
 * Layout 2 (#47) stores state per row and per mutation, because the KVS has no
 * key enumeration: each confirmed row is a `row/{collection}/{id}` value with a
 * per-collection `rowIndex/{collection}` id-array; each pending mutation is a
 * `journal/{clientId}/{mutationId}` body with a compact ordered `journalIndex`.
 * A single `putRow`/`appendMutation` rewrites one value plus a small index —
 * never the whole collection or journal — and `acknowledge` drops acked bodies
 * without rewriting the survivors. `collections`, `counters`, and `cookie`
 * carry over unchanged. A store opened at an earlier layout is migrated forward
 * once, transparently.
 *
 * Read-modify-write operations are serialized through a semaphore, which
 * makes one store instance safe for concurrent fibers — not for concurrent
 * processes (the service-worker host is the per-origin singleton, ADR-0010).
 *
 * Reads decode each persisted value through a `Schema` codec, so a corrupt or
 * format-drifted value on a rehydrating host fails as a `StoreError` instead
 * of a silent `as A` cast. Only the *envelopes* are validated — row values
 * and mutation args stay `Unknown` and round-trip untouched (ADR-0014).
 */
export const makeKeyValue = (
  options?: KeyValueOptions
): Effect.Effect<ClientStore, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = KeyValueStore.prefix(
      yield* KeyValueStore.KeyValueStore,
      options?.prefix ?? "legation/"
    );
    const highWater = options?.journalHighWater;
    const lock = yield* Semaphore.make(1);
    const locked = <A, E>(effect: Effect.Effect<A, E>) => Semaphore.withPermit(lock, effect);

    const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });

    const readDecoded = <A>(
      key: string,
      codec: Schema.Codec<A, string>
    ): Effect.Effect<A | undefined, StoreError> =>
      store.get(key).pipe(
        Effect.mapError(storeError(`Failed to read "${key}"`)),
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed(undefined)
            : Schema.decodeUnknownEffect(codec)(raw).pipe(
                Effect.mapError(storeError(`Corrupt persisted state at "${key}"`))
              )
        )
      );
    const writeJson = (key: string, value: unknown): Effect.Effect<void, StoreError> =>
      store
        .set(key, JSON.stringify(value))
        .pipe(Effect.mapError(storeError(`Failed to write "${key}"`)));
    const remove = (key: string): Effect.Effect<void, StoreError> =>
      store.remove(key).pipe(Effect.mapError(storeError(`Failed to remove "${key}"`)));

    const rowIndex = (collection: string): Effect.Effect<ReadonlyArray<string>, StoreError> =>
      readDecoded(rowIndexKey(collection), IdsFromJson).pipe(Effect.map((ids) => ids ?? []));
    const collections = readDecoded("collections", CollectionsFromJson).pipe(
      Effect.map((list) => list ?? [])
    );
    const trackCollection = (collection: string) =>
      collections.pipe(
        Effect.flatMap((list) =>
          list.includes(collection) ? Effect.void : writeJson("collections", [...list, collection])
        )
      );
    const journalIndex = readDecoded("journalIndex", JournalIndexFromJson).pipe(
      Effect.map((entries) => entries ?? [])
    );

    // Read a collection's rows through the per-row index; a corrupt row value
    // fails as a StoreError (envelope-validated). When no index exists, fall
    // back to a legacy blob at `rows/{collection}` — the read side of the
    // transparent migration, so a store not yet split still reads correctly.
    const listRowsOf = (collection: string): Effect.Effect<ReadonlyArray<StoredRow>, StoreError> =>
      Effect.gen(function* () {
        const ids = yield* readDecoded(rowIndexKey(collection), IdsFromJson);
        if (ids === undefined) {
          const legacy = yield* readDecoded(legacyRowsKey(collection), RowMapFromJson);
          return legacy === undefined ? [] : Object.values(legacy);
        }
        const rows: Array<StoredRow> = [];
        for (const id of ids) {
          const row = yield* readDecoded(rowKey(collection, id), RowFromJson);
          if (row !== undefined) rows.push(row);
        }
        return rows;
      });

    const pendingMutationsOf: Effect.Effect<ReadonlyArray<Mutation>, StoreError> = Effect.gen(
      function* () {
        const index = yield* readDecoded("journalIndex", JournalIndexFromJson);
        if (index === undefined) {
          const legacy = yield* readDecoded(LEGACY_JOURNAL_KEY, JournalFromJson);
          return legacy ?? [];
        }
        const mutations: Array<Mutation> = [];
        for (const entry of index) {
          const body = yield* readDecoded(
            journalBodyKey(entry.clientId, entry.mutationId),
            MutationFromJson
          );
          if (body !== undefined) mutations.push(body);
        }
        return mutations;
      }
    );

    // Clear every tracked collection's rows and indexes (unlocked inner form,
    // reused by clearRows, applyRowOps, and the migration reset).
    const clearRowsInner = Effect.gen(function* () {
      for (const collection of yield* collections) {
        for (const id of yield* rowIndex(collection)) yield* remove(rowKey(collection, id));
        yield* remove(rowIndexKey(collection));
        yield* remove(legacyRowsKey(collection));
      }
      yield* writeJson("collections", []);
    });

    // Apply one collection's grouped changes: write/remove each row value, then
    // rewrite the id-index once (the only O(collection) cost, paid once per
    // touched collection per batch — never once per op).
    const flushCollection = (collection: string, changes: RowChanges) =>
      Effect.gen(function* () {
        const ids = new Set(yield* rowIndex(collection));
        for (const [id, row] of changes) {
          if (row === null) {
            yield* remove(rowKey(collection, id));
            ids.delete(id);
          } else {
            yield* writeJson(rowKey(collection, id), row);
            ids.add(id);
          }
        }
        yield* writeJson(rowIndexKey(collection), [...ids]);
        yield* trackCollection(collection);
      });

    const applyRowOpsInner = (ops: ReadonlyArray<PatchOp>) =>
      Effect.gen(function* () {
        const plan = planRowOps(ops);
        if (plan.clear) yield* clearRowsInner;
        for (const [collection, changes] of plan.groups)
          yield* flushCollection(collection, changes);
      });

    // Split a legacy whole-collection blob into per-row keys + an id-index.
    const migrateCollection = (collection: string) =>
      Effect.gen(function* () {
        const map = yield* readDecoded(legacyRowsKey(collection), RowMapFromJson);
        if (map === undefined) return;
        const ids = Object.keys(map);
        for (const id of ids) yield* writeJson(rowKey(collection, id), map[id]);
        yield* writeJson(rowIndexKey(collection), ids);
        yield* remove(legacyRowsKey(collection));
      });

    // Split the legacy whole-journal array into per-mutation bodies + an index.
    const migrateJournal = Effect.gen(function* () {
      const legacy = yield* readDecoded(LEGACY_JOURNAL_KEY, JournalFromJson);
      if (legacy === undefined) return;
      const index: Array<JournalIndexEntry> = [];
      for (const m of legacy) {
        yield* writeJson(journalBodyKey(m.clientId, m.mutationId), m);
        index.push({ clientId: m.clientId, mutationId: m.mutationId });
      }
      yield* writeJson("journalIndex", index);
      yield* remove(LEGACY_JOURNAL_KEY);
    });

    // Last resort when a legacy blob is corrupt beyond recovery: the store is a
    // cache of server state, so drop the rows + journal and reset the cookie,
    // leaving the client able to re-pull from scratch (counters survive).
    const resetToEmpty = Effect.gen(function* () {
      yield* clearRowsInner;
      yield* remove(LEGACY_JOURNAL_KEY);
      yield* remove("journalIndex");
      yield* remove("cookie");
    });

    // Migrate a layout-1 (or unstamped) store into layout 2 once, then stamp
    // the version. Envelope-validated; a corrupt legacy blob takes the
    // destructive fallback rather than wedging the store.
    const migrate = Effect.gen(function* () {
      for (const collection of yield* collections) yield* migrateCollection(collection);
      yield* migrateJournal;
    }).pipe(Effect.catch(() => resetToEmpty));

    // Transparent forward-migration on first open. Each collection migrates
    // atomically — the id-index is written only after every row value, and the
    // legacy blob removed only after the index — so a mid-flight failure leaves
    // the collection readable via the legacy fallback, and the version is
    // stamped only once migration completes, so the next open simply retries.
    // Kept infallible at construction (like the original zero-I/O open): a
    // transient store error here is swallowed, and reads still resolve through
    // the legacy fallback until the next open re-migrates.
    const openMigration = Effect.gen(function* () {
      const version = yield* store.get(LAYOUT_KEY);
      if (version !== CURRENT_LAYOUT) {
        yield* locked(migrate.pipe(Effect.andThen(store.set(LAYOUT_KEY, CURRENT_LAYOUT))));
      }
    });
    yield* openMigration.pipe(Effect.catch(() => Effect.void));

    // Local store-version buster (#48): a mismatch clears confirmed rows + the
    // cookie (so the next pull rehydrates fully) but preserves the journal, then
    // stamps the new version. Kept infallible at construction, like the
    // migration open above.
    const openStoreVersion = Effect.gen(function* () {
      const desired = options?.storeVersion;
      if (desired === undefined) return;
      const current = yield* store.get(STORE_VERSION_KEY);
      if (current === desired) return;
      const stampVersion = store
        .set(STORE_VERSION_KEY, desired)
        .pipe(Effect.mapError(storeError(`Failed to write "${STORE_VERSION_KEY}"`)));
      yield* locked(
        clearRowsInner.pipe(
          Effect.andThen(remove("cookie")),
          // Journal deliberately untouched: pending intents survive the buster.
          Effect.andThen(stampVersion)
        )
      );
    });
    yield* openStoreVersion.pipe(Effect.catch(() => Effect.void));

    return ClientStore.of({
      getRow: (collection, id) => readDecoded(rowKey(collection, id), RowFromJson),
      listRows: listRowsOf,
      listCollections: collections,
      putRow: (collection, row) =>
        locked(
          Effect.gen(function* () {
            yield* writeJson(rowKey(collection, row.id), row);
            const ids = yield* rowIndex(collection);
            if (!ids.includes(row.id)) yield* writeJson(rowIndexKey(collection), [...ids, row.id]);
            yield* trackCollection(collection);
          })
        ),
      delRow: (collection, id) =>
        locked(
          Effect.gen(function* () {
            yield* remove(rowKey(collection, id));
            const ids = yield* rowIndex(collection);
            if (ids.includes(id))
              yield* writeJson(
                rowIndexKey(collection),
                ids.filter((x) => x !== id)
              );
          })
        ),
      clearRows: locked(clearRowsInner),
      applyRowOps: (ops) => locked(applyRowOpsInner(ops)),

      appendMutation: (mutation) =>
        locked(
          Effect.gen(function* () {
            const index = yield* journalIndex;
            if (highWater !== undefined && index.length >= highWater) {
              return yield* new StoreError({
                message: `Journal high-water exceeded (${highWater} pending mutations); refusing to drop the intent`,
              });
            }
            yield* writeJson(journalBodyKey(mutation.clientId, mutation.mutationId), mutation);
            yield* writeJson("journalIndex", [
              ...index,
              { clientId: mutation.clientId, mutationId: mutation.mutationId },
            ]);
          })
        ),
      pendingMutations: pendingMutationsOf,
      acknowledge: (clientId, upTo) =>
        locked(
          Effect.gen(function* () {
            const kept: Array<JournalIndexEntry> = [];
            for (const entry of yield* journalIndex) {
              if (entry.clientId === clientId && entry.mutationId <= upTo) {
                yield* remove(journalBodyKey(entry.clientId, entry.mutationId));
              } else {
                kept.push(entry);
              }
            }
            yield* writeJson("journalIndex", kept);
          })
        ),
      nextMutationId: (clientId) =>
        locked(
          Effect.gen(function* () {
            const counters = (yield* readDecoded("counters", CountersFromJson)) ?? {};
            const next = (counters[clientId] ?? 0) + 1;
            yield* writeJson("counters", { ...counters, [clientId]: next });
            return next;
          })
        ),

      getCookie: store.get("cookie").pipe(Effect.mapError(storeError(`Failed to read "cookie"`))),
      setCookie: (value) =>
        store.set("cookie", value).pipe(Effect.mapError(storeError(`Failed to write "cookie"`))),
    });
  });

/** Layer providing the KeyValueStore-backed store. */
export const layerKeyValue = (
  options?: KeyValueOptions
): Layer.Layer<ClientStore, never, KeyValueStore.KeyValueStore> =>
  Layer.effect(ClientStore)(makeKeyValue(options));
