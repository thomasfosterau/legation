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
 *
 * The store is also where the **identity boundary** lives (CONTEXT.md): it
 * stamps the {@link Identity.Fingerprint} whose session authorised the rows
 * it holds, compares that stamp on open, and owns the **quarantine** — the
 * keyspace a superseded identity's unpushed journal entries move to, so they
 * are neither discarded nor adopted by the next principal.
 */

import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { KeyValueStore } from "effect/persistence";
import type { RowId } from "./Collection.js";
import { StoreError } from "./Errors.js";
import * as Identity from "./Identity.js";
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

/**
 * What a {@link ClientStore.compactPending} call did: the ids dropped, and the
 * surviving entries it moved (`from` is the id before, `to` the id after).
 * Both empty when nothing was eligible.
 */
export interface CompactionResult {
  readonly dropped: ReadonlyArray<number>;
  readonly renumbered: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

/** The empty {@link CompactionResult}: nothing was dropped or moved. */
export const NO_COMPACTION: CompactionResult = { dropped: [], renumbered: [] };

/** What a journal entry must expose for {@link planCompaction}: its owner and id. */
interface Numbered {
  readonly clientId: string;
  readonly mutationId: number;
}

/** A computed compaction: its result plus the journal and counter it leaves behind. */
interface CompactionPlan<T extends Numbered> {
  readonly result: CompactionResult;
  /** The whole journal after the compaction, in order (other clients untouched). */
  readonly journal: ReadonlyArray<T>;
  /** The id `clientId`'s counter must hold afterwards, so the next id continues the run. */
  readonly counter: number;
}

/**
 * Plan a compaction over the whole `journal` for `clientId`. Pure and generic
 * over the entry shape, so the memory store plans over full mutations while
 * the durable store plans over its compact index (ids only, #249 review S3:
 * a paced flush must not read every body in the journal). Shared so both
 * agree on the rule.
 *
 * Eligible ids: pending, `clientId`'s own, above `sentUpTo`. Survivors above
 * `sentUpTo` take consecutive ids after the anchor, in journal order; the
 * anchor is the highest frozen id still pending, or the lowest pending id
 * minus one when nothing is frozen (the journal is contiguous from the last
 * acknowledged id, so that is `lastAcknowledged`). Frozen entries are never
 * touched.
 */
const planCompaction = <T extends Numbered>(
  journal: ReadonlyArray<T>,
  clientId: string,
  mutationIds: ReadonlyArray<number>,
  sentUpTo: number
): CompactionPlan<T> | undefined => {
  const wanted = new Set(mutationIds);
  const mine = journal.filter((m) => m.clientId === clientId);
  const dropped = mine
    .filter((m) => m.mutationId > sentUpTo && wanted.has(m.mutationId))
    .map((m) => m.mutationId);
  if (dropped.length === 0) return undefined;
  const droppedSet = new Set(dropped);
  const frozen = mine.filter((m) => m.mutationId <= sentUpTo);
  const anchor =
    frozen.length > 0
      ? Math.max(...frozen.map((m) => m.mutationId))
      : Math.min(...mine.map((m) => m.mutationId)) - 1;
  const renumbered: Array<{ from: number; to: number }> = [];
  const after: Array<T> = [];
  let next = anchor;
  for (const m of journal) {
    if (m.clientId !== clientId || m.mutationId <= sentUpTo) {
      after.push(m);
      continue;
    }
    if (droppedSet.has(m.mutationId)) continue;
    next += 1;
    if (next === m.mutationId) {
      after.push(m);
      continue;
    }
    renumbered.push({ from: m.mutationId, to: next });
    after.push({ ...m, mutationId: next });
  }
  return { result: { dropped, renumbered }, journal: after, counter: next };
};

/** A client's durable state: confirmed rows, the pending-mutation journal and the sync cookie. */
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
  /**
   * Compact the unpushed tail of `clientId`'s journal (#117's pacing
   * strategies: debounce/throttle/coalesce drop a superseded entry) **and
   * renumber the survivors** (#249), as one atomic step.
   *
   * The backend's exactly-once ledger (ADR-0008) requires a client's mutation
   * ids to arrive gap-free: `id <= lastMutationId` is skipped, `id ===
   * lastMutationId + 1` is applied, anything above is rejected. Dropping an
   * entry and leaving the rest alone therefore strands the journal behind a
   * gap no backend will accept. So after dropping, the client's unpushed
   * survivors are renumbered contiguously — in journal order, continuing on
   * from the last entry that is frozen (or from the first pending id when
   * nothing is) — and the id counter is rewound so the next
   * {@link ClientStore.nextMutationId} continues the run.
   *
   * Only entries **above the {@link ClientStore.markSent} watermark** are
   * ever dropped or renumbered: anything a push attempt may have put on the
   * wire keeps its id forever (a renumbered, already-applied write would be
   * applied twice). Ids in `mutationIds` that are not pending, are frozen, or
   * belong to another client are silently skipped.
   *
   * Atomic and restartable: a durable implementation must finish or roll
   * forward an interrupted compaction on the next open, so a crash never
   * leaves a gap, a duplicate id, or a counter that disagrees with the
   * journal. The mutations dropped here were never sent, so no
   * acknowledgement is implied.
   */
  readonly compactPending: (
    clientId: string,
    mutationIds: ReadonlyArray<number>
  ) => Effect.Effect<CompactionResult, StoreError>;
  /**
   * Record that a push attempt may have sent `clientId`'s entries with
   * `mutationId <= upTo` (monotonic: a lower value is ignored). Written
   * *before* the request leaves, because a failed round trip does not prove
   * the backend did not apply it. The watermark is what
   * {@link ClientStore.compactPending} treats as frozen, and it is persisted
   * so the boundary survives a restart and is shared by every engine
   * instance over the same store.
   */
  readonly markSent: (clientId: string, upTo: number) => Effect.Effect<void, StoreError>;
  readonly nextMutationId: (clientId: string) => Effect.Effect<number, StoreError>;

  // Sync bookkeeping
  readonly getCookie: Effect.Effect<string | undefined, StoreError>;
  readonly setCookie: (cookie: string) => Effect.Effect<void, StoreError>;
  /**
   * Forget the pull cookie, so the next pull is a full reset (`Cvr` sends
   * `Clear` + full puts for an absent cookie). Part of dropping a replica on
   * an identity change — a cookie kept past its rows would ask the server for
   * a *diff* against rows this client no longer has.
   */
  readonly clearCookie: Effect.Effect<void, StoreError>;

  // Identity boundary
  /**
   * The fingerprint whose session authorised the rows this store holds, or
   * `undefined` when the store has never been stamped (see
   * {@link Identity.unstamped}).
   */
  readonly getIdentity: Effect.Effect<Identity.Fingerprint | undefined, StoreError>;
  /** Stamp the replica as belonging to `fingerprint`. */
  readonly setIdentity: (fingerprint: Identity.Fingerprint) => Effect.Effect<void, StoreError>;

  // Quarantine
  /**
   * Move every pending journal entry into the quarantine keyed by
   * `fingerprint`, emptying the journal. Returns how many entries moved.
   *
   * This is the answer to the one question an identity change has no safe
   * default for: discarding a user's unsynced writes on sign-out is data
   * loss, and adopting them into the next session is a security bug. A
   * quarantined entry is **outside the journal**, so `pendingMutations` — and
   * therefore every push — cannot see it: it is unpushable under any identity
   * but the one it is keyed by.
   *
   * Mutation ids are preserved exactly. A quarantined entry may have been
   * in flight when the reset happened, and the backend's exactly-once ledger
   * (ADR-0008) is keyed by mutation id: renumbering could apply a write
   * twice, where keeping the id at worst has it acknowledged and skipped.
   * Re-quarantining under a fingerprint that already holds one appends,
   * preserving causal order within each batch.
   */
  readonly quarantinePending: (
    fingerprint: Identity.Fingerprint
  ) => Effect.Effect<number, StoreError>;
  /** The entries held under `fingerprint`, in causal order; empty when none. */
  readonly quarantinedMutations: (
    fingerprint: Identity.Fingerprint
  ) => Effect.Effect<ReadonlyArray<Mutation>, StoreError>;
  /** Every fingerprint currently holding a quarantine — what an app lists to offer a discard. */
  readonly quarantines: Effect.Effect<ReadonlyArray<Identity.Fingerprint>, StoreError>;
  /**
   * Move `fingerprint`'s quarantined entries back into the journal, making
   * them pushable again — what re-signing in as that identity does. Returns
   * how many entries were released. Appends to whatever is already pending.
   */
  readonly releaseQuarantine: (
    fingerprint: Identity.Fingerprint
  ) => Effect.Effect<number, StoreError>;
  /**
   * Delete `fingerprint`'s quarantine outright. **The only path that destroys
   * a quarantined write intent**, and deliberately an explicit call: no reset
   * and no boot may trigger it, because the alternative is an engine that
   * quietly throws away a departed user's unsynced work.
   */
  readonly discardQuarantine: (
    fingerprint: Identity.Fingerprint
  ) => Effect.Effect<void, StoreError>;
}

/** The {@link ClientStore} service a Client or engine persists through. */
export const ClientStore = Context.Service<ClientStore>("@legation/effect/ClientStore");

/**
 * Freeze everything currently pending: raise each client's sent watermark to
 * its highest pending id, so {@link ClientStore.compactPending} treats it as
 * possibly-sent and leaves it alone (#249). Used wherever entries arrive whose
 * push history this process cannot see: engine boot (a journal persisted by an
 * earlier session, or by a release that predates the watermark, may have been
 * pushed) and snapshot hydration (the entries came from another context). The
 * cost is only that such entries are never compacted, which is what a paced
 * caller, tracking ids in memory, would not have attempted anyway.
 */
export const freezePending = (store: ClientStore): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const highest = new Map<string, number>();
    for (const m of yield* store.pendingMutations) {
      if (m.mutationId > (highest.get(m.clientId) ?? 0)) highest.set(m.clientId, m.mutationId);
    }
    yield* Effect.forEach(highest, ([clientId, upTo]) => store.markSent(clientId, upTo), {
      discard: true,
    });
  });

/** In-memory implementation (tests, SSR, ephemeral clients). */
export const makeMemory: Effect.Effect<ClientStore> = Effect.gen(function* () {
  const rows = yield* Ref.make(new Map<string, Map<RowId, StoredRow>>());
  const journal = yield* Ref.make<ReadonlyArray<Mutation>>([]);
  const counters = yield* Ref.make(new Map<string, number>());
  const sentUpTo = yield* Ref.make(new Map<string, number>());
  const cookie = yield* Ref.make<string | undefined>(undefined);
  const identity = yield* Ref.make<Identity.Fingerprint | undefined>(undefined);
  const quarantine = yield* Ref.make(new Map<Identity.Fingerprint, ReadonlyArray<Mutation>>());

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
    // Uninterruptible: the journal and the counter must change together. An
    // interrupt between the two writes would leave a renumbered journal with a
    // counter that still hands out the old numbering, i.e. a gap (#249).
    compactPending: (clientId, mutationIds) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const watermark = (yield* Ref.get(sentUpTo)).get(clientId) ?? 0;
          // Journal and plan move together in one `Ref.modify`, so a concurrent
          // append cannot slip between the read and the write.
          const plan = yield* Ref.modify(journal, (entries) => {
            const planned = planCompaction(entries, clientId, mutationIds, watermark);
            return planned === undefined ? [undefined, entries] : [planned, planned.journal];
          });
          if (plan === undefined) return NO_COMPACTION;
          // A yield point between the two writes: harmless here, and what lets
          // a test (and a real preemption) interrupt exactly in the window the
          // uninterruptible wrapper exists to close.
          yield* Effect.yieldNow;
          yield* Ref.update(counters, (m) => new Map(m).set(clientId, plan.counter));
          return plan.result;
        })
      ),
    markSent: (clientId, upTo) =>
      Ref.update(sentUpTo, (m) =>
        (m.get(clientId) ?? 0) >= upTo ? m : new Map(m).set(clientId, upTo)
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
    clearCookie: Ref.set(cookie, undefined),

    getIdentity: Ref.get(identity),
    setIdentity: (fingerprint) => Ref.set(identity, fingerprint),

    quarantinePending: (fingerprint) =>
      Effect.gen(function* () {
        const entries = yield* Ref.getAndSet(journal, []);
        if (entries.length === 0) return 0;
        yield* Ref.update(quarantine, (held) =>
          new Map(held).set(fingerprint, [...(held.get(fingerprint) ?? []), ...entries])
        );
        return entries.length;
      }),
    quarantinedMutations: (fingerprint) =>
      Ref.get(quarantine).pipe(Effect.map((held) => held.get(fingerprint) ?? [])),
    quarantines: Ref.get(quarantine).pipe(Effect.map((held) => [...held.keys()])),
    releaseQuarantine: (fingerprint) =>
      Effect.gen(function* () {
        const held = yield* Ref.get(quarantine);
        const entries = held.get(fingerprint) ?? [];
        if (entries.length === 0) return 0;
        yield* Ref.update(journal, (pending) => [...pending, ...entries]);
        yield* Ref.update(quarantine, (map) => {
          const next = new Map(map);
          next.delete(fingerprint);
          return next;
        });
        return entries.length;
      }),
    discardQuarantine: (fingerprint) =>
      Ref.update(quarantine, (map) => {
        const next = new Map(map);
        next.delete(fingerprint);
        return next;
      }),
  });
});

/** Layer providing the in-memory store. */
export const layerMemory: Layer.Layer<ClientStore> = Layer.effect(ClientStore)(makeMemory);

/**
 * A store that refuses every operation with `cause`.
 *
 * The fail-closed end of the identity boundary (#212). If the open-time
 * identity transition cannot be completed — a corrupt journal blob, a KVS
 * that errors mid-reset — the replica's rows may still belong to the
 * superseded principal and its journal may still hold that principal's
 * unpushed intents. Serving either is the exact bug the boundary exists to
 * prevent, and neither clearing (data loss) nor continuing (a security bug)
 * is acceptable, so the store is sealed instead: reads and writes fail
 * loudly, nothing is pushed, and nothing is destroyed. The durable state is
 * untouched and the next open retries the whole transition.
 */
const sealed = (cause: StoreError): ClientStore => {
  const refuse = <A>(): Effect.Effect<A, StoreError> =>
    Effect.fail(
      new StoreError({
        message:
          "ClientStore is sealed: the identity boundary could not be established on open, " +
          "so this replica cannot safely be read or written. The durable state is intact; " +
          "retry by reopening the store.",
        cause,
      })
    );
  return ClientStore.of({
    getRow: () => refuse(),
    listRows: () => refuse(),
    listCollections: refuse(),
    putRow: () => refuse(),
    delRow: () => refuse(),
    clearRows: refuse(),
    applyRowOps: () => refuse(),
    appendMutation: () => refuse(),
    pendingMutations: refuse(),
    acknowledge: () => refuse(),
    compactPending: () => refuse(),
    markSent: () => refuse(),
    nextMutationId: () => refuse(),
    getCookie: refuse(),
    setCookie: () => refuse(),
    clearCookie: refuse(),
    getIdentity: refuse(),
    setIdentity: () => refuse(),
    quarantinePending: () => refuse(),
    quarantinedMutations: () => refuse(),
    quarantines: refuse(),
    releaseQuarantine: () => refuse(),
    discardQuarantine: () => refuse(),
  });
};

// ─── KeyValueStore-backed implementation ─────────────────────────────────────

/** Options for a {@link ClientStore} over an Effect `KeyValueStore`. */
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
  /**
   * The identity this replica belongs to (CONTEXT.md, "Identity boundary").
   * Supplying it turns the boundary on: the store compares this fingerprint
   * with its stamp on open and applies {@link Identity.transitionOf} —
   *
   * - **Unchanged**: the same principal, so nothing happens.
   * - **Upgrade** ({@link Identity.anonymous} → signed in): the warm replica
   *   and the journal survive; only the stamp changes. Public rows are a
   *   subset of what the new identity may read, and the pending writes are
   *   the same person's, made on this device moments earlier.
   * - **Reset**: every other change, sign-out included. Unpushed journal
   *   entries are quarantined under the **superseded** fingerprint (never
   *   discarded, never inherited), then confirmed rows and the pull cookie
   *   are dropped, so the next pull rehydrates from scratch under the new
   *   identity. A replica that has never been stamped counts as
   *   {@link Identity.unstamped} and therefore always resets — one full
   *   re-pull the first time an app turns the boundary on, which is the safe
   *   direction.
   *
   * Either way, a quarantine already held under the adopted fingerprint is
   * released back into the journal: re-signing in makes that identity's own
   * unpushed writes pushable again. Nothing here ever *discards* a
   * quarantine — that is {@link ClientStore.discardQuarantine} alone.
   *
   * Unset leaves the store unstamped and unchecked (today's behaviour). The
   * alternative to resetting is namespacing: derive {@link KeyValueOptions.prefix}
   * (or the IndexedDB database) from the fingerprint so each principal has
   * its own replica — see `IndexedDbClientStore.layerNamespaced`.
   */
  readonly identity?: Identity.Fingerprint;
}

/**
 * The current durable layout version. Stamped at `__layout` on first open; a
 * store found at an earlier (or absent) version is migrated forward once (#47).
 */
const CURRENT_LAYOUT = "2";
const LAYOUT_KEY = "__layout";
/** Where the app-supplied {@link KeyValueOptions.storeVersion} is persisted (#48). */
const STORE_VERSION_KEY = "__storeVersion";
/** Where the replica's {@link Identity.Fingerprint} stamp is persisted (#212). */
const IDENTITY_KEY = "__identity";
/** The index of fingerprints currently holding a quarantine. */
const QUARANTINE_INDEX_KEY = "quarantineIndex";
/** The in-progress compaction's write-ahead intent (#249); present only mid-compaction. */
const COMPACTION_KEY = "compactionIntent";
/** Per-client highest mutation id a push attempt may have sent (#249). */
const SENT_KEY = "sentUpTo";

/** Per-row / per-mutation key builders (layout 2). */
const rowKey = (collection: string, id: string) => `row/${collection}/${id}`;
const rowIndexKey = (collection: string) => `rowIndex/${collection}`;
const journalBodyKey = (clientId: string, mutationId: number) =>
  `journal/${clientId}/${mutationId}`;
/**
 * A quarantine's whole body, keyed by the fingerprint it is held under
 * (percent-encoded, since a fingerprint is opaque app-supplied text). Unlike
 * the journal this is a single blob: a quarantine is written once on reset
 * and read once on release, so the per-entry write amplification layout 2
 * exists to avoid never arises.
 */
const quarantineKey = (fingerprint: Identity.Fingerprint) =>
  `quarantine/${Identity.keySegment(fingerprint)}`;
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
/**
 * The write-ahead record of an in-progress compaction (#249): everything
 * needed to finish it from scratch, so replaying it is idempotent.
 */
const CompactionIntentFromJson = Schema.fromJsonString(
  Schema.Struct({
    clientId: Schema.String,
    /** Body keys to clear first: every dropped id and every old id of a moved entry. */
    staleIds: Schema.Array(Schema.Number),
    /** The renumbered bodies, at their new ids. */
    moved: Schema.Array(MutationSchema),
    /** The complete journal index once the compaction has applied. */
    index: Schema.Array(JournalIndexEntrySchema),
    /** The value `clientId`'s counter takes once it has applied. */
    counter: Schema.Number,
  })
);
/** A quarantine body, and the index of fingerprints holding one. */
const MutationsFromJson = Schema.fromJsonString(Schema.Array(MutationSchema));
const FingerprintsFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
/** Legacy whole-blob codecs, read only on the migration / fallback path. */
const RowMapFromJson = Schema.fromJsonString(Schema.Record(Schema.String, StoredRowSchema));
const JournalFromJson = MutationsFromJson;

/**
 * Append `incoming` to `held`, skipping entries already there by
 * (clientId, mutationId). Quarantining is not one atomic KVS write, so a
 * crash between writing the quarantine and emptying the journal leaves the
 * open path to re-quarantine the same entries on the next boot; deduping
 * makes that retry idempotent instead of doubling the batch.
 */
const appendDistinct = (
  held: ReadonlyArray<Mutation>,
  incoming: ReadonlyArray<Mutation>
): ReadonlyArray<Mutation> => {
  const seen = new Set(held.map((m) => `${m.clientId}/${m.mutationId}`));
  return [...held, ...incoming.filter((m) => !seen.has(`${m.clientId}/${m.mutationId}`))];
};

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
 * `effect/persistence` KeyValueStore, so any platform KVS —
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

    // ─── Compaction (unlocked inner forms; #249) ───────────────────────────
    //
    // Dropping superseded entries and renumbering the survivors rewrites
    // several keys, and the KVS has no transactions. So the whole outcome is
    // first written as ONE record (`compactionIntent`) — the commit point —
    // and then applied by steps that are each idempotent: clear the stale
    // bodies, write the renumbered bodies, write the index, rewind the
    // counter, delete the intent. A crash anywhere before the intent lands
    // leaves the old, contiguous journal untouched; a crash after it is
    // rolled forward by `recoverCompaction` on the next open. Either way the
    // journal, the index and the counter agree and the ids stay gap-free.
    // (Writing new bodies in place without the intent could overwrite a live
    // entry's body before the index moved, which is the corruption this
    // avoids.)
    const applyCompaction = (intent: typeof CompactionIntentFromJson.Type) =>
      Effect.gen(function* () {
        for (const id of intent.staleIds) yield* remove(journalBodyKey(intent.clientId, id));
        for (const m of intent.moved) yield* writeJson(journalBodyKey(m.clientId, m.mutationId), m);
        yield* writeJson("journalIndex", intent.index);
        const counters = (yield* readDecoded("counters", CountersFromJson)) ?? {};
        yield* writeJson("counters", { ...counters, [intent.clientId]: intent.counter });
        yield* remove(COMPACTION_KEY);
      });
    // Set while an intent may still be on disk, so any journal operation
    // finishes it first (an earlier apply can fail without a crash, and an
    // append landing before the replay would be clobbered by it).
    let compactionPending = false;
    const recoverCompaction = Effect.gen(function* () {
      const intent = yield* readDecoded(COMPACTION_KEY, CompactionIntentFromJson);
      if (intent !== undefined) yield* applyCompaction(intent);
      compactionPending = false;
    });
    const settleCompaction: Effect.Effect<void, StoreError> = Effect.suspend(() =>
      compactionPending ? recoverCompaction : Effect.void
    );
    const sentMarks = readDecoded(SENT_KEY, CountersFromJson).pipe(
      Effect.map((marks) => marks ?? {})
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

    // ─── Quarantine (unlocked inner forms; #212) ───────────────────────────
    //
    // A quarantine lives in its own keyspace, not in the journal — that is
    // the security property, not an implementation detail: `pendingMutations`
    // reads the journal, `push` reads `pendingMutations`, so an entry moved
    // here is structurally unreachable from any push, whatever identity is
    // signed in. Nothing but `discardQuarantine` ever deletes one.

    const quarantineIndexOf: Effect.Effect<
      ReadonlyArray<Identity.Fingerprint>,
      StoreError
    > = readDecoded(QUARANTINE_INDEX_KEY, FingerprintsFromJson).pipe(
      Effect.map((list) => list ?? [])
    );

    const quarantinedOf = (
      fingerprint: Identity.Fingerprint
    ): Effect.Effect<ReadonlyArray<Mutation>, StoreError> =>
      readDecoded(quarantineKey(fingerprint), MutationsFromJson).pipe(
        Effect.map((entries) => entries ?? [])
      );

    // Empty the journal outright — bodies, index, and any legacy blob — with
    // no acknowledgement implied. Only ever called with the entries already
    // safely written to a quarantine.
    const clearJournalInner = Effect.gen(function* () {
      for (const entry of yield* journalIndex) {
        yield* remove(journalBodyKey(entry.clientId, entry.mutationId));
      }
      yield* writeJson("journalIndex", []);
      yield* remove(LEGACY_JOURNAL_KEY);
    });

    // Quarantine first, empty the journal second: a crash between the two
    // leaves the entries in both places, which the next boot re-quarantines
    // idempotently (`appendDistinct`) — where the opposite order would lose
    // them. The identity stamp is written after all of this, so an
    // interrupted reset simply runs again on the next open.
    const quarantinePendingInner = (
      fingerprint: Identity.Fingerprint
    ): Effect.Effect<number, StoreError> =>
      Effect.gen(function* () {
        const pending = yield* pendingMutationsOf;
        if (pending.length === 0) return 0;
        const held = yield* quarantinedOf(fingerprint);
        yield* writeJson(quarantineKey(fingerprint), appendDistinct(held, pending));
        const index = yield* quarantineIndexOf;
        if (!index.includes(fingerprint)) {
          yield* writeJson(QUARANTINE_INDEX_KEY, [...index, fingerprint]);
        }
        yield* clearJournalInner;
        return pending.length;
      });

    const discardQuarantineInner = (
      fingerprint: Identity.Fingerprint
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        yield* remove(quarantineKey(fingerprint));
        const index = yield* quarantineIndexOf;
        if (index.includes(fingerprint)) {
          yield* writeJson(
            QUARANTINE_INDEX_KEY,
            index.filter((held) => held !== fingerprint)
          );
        }
      });

    const releaseQuarantineInner = (
      fingerprint: Identity.Fingerprint
    ): Effect.Effect<number, StoreError> =>
      Effect.gen(function* () {
        const entries = yield* quarantinedOf(fingerprint);
        if (entries.length === 0) return 0;
        const index = yield* journalIndex;
        const restored: Array<JournalIndexEntry> = [];
        for (const entry of entries) {
          yield* writeJson(journalBodyKey(entry.clientId, entry.mutationId), entry);
          restored.push({ clientId: entry.clientId, mutationId: entry.mutationId });
        }
        yield* writeJson("journalIndex", [...index, ...restored]);
        yield* discardQuarantineInner(fingerprint);
        return entries.length;
      });

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

    // Finish a compaction a previous run was interrupted in (#249). Kept
    // infallible at construction like the opens around it: if recovery fails
    // here the flag stays set, and the first journal operation retries it.
    yield* locked(recoverCompaction).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          compactionPending = true;
        })
      )
    );

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

    // The identity boundary on open (#212): compare the configured
    // fingerprint with the replica's stamp and apply `Identity.transitionOf`.
    // A `Reset` quarantines the unpushed journal under the **superseded**
    // fingerprint before dropping rows and the cookie, so the previous
    // principal's rows are never served to this one and their write intents
    // are neither lost nor inherited. The stamp is the last write of the
    // transition, so an interrupted reset re-runs on the next open rather
    // than leaving a replica stamped for an identity it was never cleared
    // for. The release runs on every open, `Unchanged` included: it is how
    // re-signing in makes this identity's own quarantined entries pushable
    // again, and it closes the crash window between stamping and releasing.
    //
    // Unset `identity` means the boundary is off — no stamp, no comparison,
    // behaviour identical to before. Kept infallible at construction, like
    // the migration and store-version opens above.
    const openIdentity = Effect.gen(function* () {
      const next = options?.identity;
      if (next === undefined) return;
      const stamped = yield* store
        .get(IDENTITY_KEY)
        .pipe(Effect.mapError(storeError(`Failed to read "${IDENTITY_KEY}"`)));
      const current = stamped ?? Identity.unstamped;
      const transition = Identity.transitionOf(current, next);
      const stamp = store
        .set(IDENTITY_KEY, next)
        .pipe(Effect.mapError(storeError(`Failed to write "${IDENTITY_KEY}"`)));
      yield* locked(
        Effect.gen(function* () {
          if (transition === "Reset") {
            yield* quarantinePendingInner(current);
            yield* clearRowsInner;
            yield* remove("cookie");
          }
          if (transition !== "Unchanged") yield* stamp;
          yield* releaseQuarantineInner(next);
        })
      );
    });
    // Unlike the two opens above, this one is NOT swallowed: a boundary that
    // could not be established must not be reported as established. The store
    // is sealed instead (see {@link sealed}) — nothing served, nothing pushed,
    // nothing destroyed, and the next open retries.
    const boundaryFailure = yield* openIdentity.pipe(
      Effect.as<StoreError | undefined>(undefined),
      Effect.catch((error) => Effect.succeed<StoreError | undefined>(error))
    );
    if (boundaryFailure !== undefined) return sealed(boundaryFailure);

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
            yield* settleCompaction;
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
      pendingMutations: locked(settleCompaction.pipe(Effect.andThen(pendingMutationsOf))),
      acknowledge: (clientId, upTo) =>
        locked(
          Effect.gen(function* () {
            yield* settleCompaction;
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
      // The commit point is the durable intent. Everything from there is
      // uninterruptible, and a failure to *apply* the intent is not a failure
      // of the compaction: it is committed, `settleCompaction` rolls it
      // forward before the next journal operation, and the caller must learn
      // the renumbering now (returning the error instead would leave the
      // engine, Paced trackers and ack handles on ids the store has already
      // left behind: the newest paced write would be dropped, #249 review B1).
      compactPending: (clientId, mutationIds) =>
        Semaphore.withPermit(
          lock,
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* settleCompaction;
              // An un-migrated legacy blob has no index to rewrite; leave it be.
              const index = yield* readDecoded("journalIndex", JournalIndexFromJson);
              if (index === undefined) return NO_COMPACTION;
              const watermark = (yield* sentMarks)[clientId] ?? 0;
              // Plan over the index alone; read only the bodies that move.
              const plan = planCompaction(index, clientId, mutationIds, watermark);
              if (plan === undefined) return NO_COMPACTION;
              const moved: Array<Mutation> = [];
              for (const { from, to } of plan.result.renumbered) {
                const body = yield* readDecoded(journalBodyKey(clientId, from), MutationFromJson);
                // A missing body cannot be moved, and leaving its index entry
                // behind would strand an id with nothing to push. Refuse, before
                // anything is committed, rather than corrupt the run.
                if (body === undefined) {
                  return yield* new StoreError({
                    message: `Journal body missing for mutation ${from} of client ${clientId}; refusing to compact`,
                  });
                }
                moved.push({ ...body, mutationId: to });
              }
              const intent = {
                clientId,
                staleIds: [...plan.result.dropped, ...plan.result.renumbered.map((r) => r.from)],
                moved,
                index: plan.journal,
                counter: plan.counter,
              };
              // Armed before the write: if the write lands but reports failure,
              // the next operation still looks for (and finishes) the intent.
              compactionPending = true;
              // A write that errors may still have landed (an ambiguous IndexedDB
              // abort): look for the intent before calling the compaction failed.
              // Present means committed, so proceed as if the write had succeeded.
              yield* writeJson(COMPACTION_KEY, intent).pipe(
                Effect.catch((error) =>
                  readDecoded(COMPACTION_KEY, CompactionIntentFromJson).pipe(
                    Effect.catch(() => Effect.succeed(undefined)),
                    Effect.flatMap((found) =>
                      found === undefined ? Effect.fail(error) : Effect.void
                    )
                  )
                )
              );
              yield* applyCompaction(intent).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    compactionPending = false;
                  })
                ),
                // The compaction is committed; the roll-forward finishes it.
                // Not silent: a store that keeps failing here will keep failing
                // the next journal operation, and this is the first sign.
                Effect.catch((error) =>
                  Effect.logWarning(
                    "ClientStore: compaction committed but not yet applied; will roll forward",
                    { error }
                  )
                )
              );
              return plan.result;
            })
          )
        ),
      markSent: (clientId, upTo) =>
        locked(
          Effect.gen(function* () {
            const marks = yield* sentMarks;
            if ((marks[clientId] ?? 0) >= upTo) return;
            yield* writeJson(SENT_KEY, { ...marks, [clientId]: upTo });
          })
        ),
      nextMutationId: (clientId) =>
        locked(
          Effect.gen(function* () {
            yield* settleCompaction;
            const counters = (yield* readDecoded("counters", CountersFromJson)) ?? {};
            const next = (counters[clientId] ?? 0) + 1;
            yield* writeJson("counters", { ...counters, [clientId]: next });
            return next;
          })
        ),

      getCookie: store.get("cookie").pipe(Effect.mapError(storeError(`Failed to read "cookie"`))),
      setCookie: (value) =>
        store.set("cookie", value).pipe(Effect.mapError(storeError(`Failed to write "cookie"`))),
      clearCookie: locked(remove("cookie")),

      getIdentity: store
        .get(IDENTITY_KEY)
        .pipe(Effect.mapError(storeError(`Failed to read "${IDENTITY_KEY}"`))),
      setIdentity: (fingerprint) =>
        store
          .set(IDENTITY_KEY, fingerprint)
          .pipe(Effect.mapError(storeError(`Failed to write "${IDENTITY_KEY}"`))),

      quarantinePending: (fingerprint) =>
        locked(settleCompaction.pipe(Effect.andThen(quarantinePendingInner(fingerprint)))),
      quarantinedMutations: quarantinedOf,
      quarantines: quarantineIndexOf,
      releaseQuarantine: (fingerprint) =>
        locked(settleCompaction.pipe(Effect.andThen(releaseQuarantineInner(fingerprint)))),
      discardQuarantine: (fingerprint) => locked(discardQuarantineInner(fingerprint)),
    });
  });

/** Layer providing the KeyValueStore-backed store. */
export const layerKeyValue = (
  options?: KeyValueOptions
): Layer.Layer<ClientStore, never, KeyValueStore.KeyValueStore> =>
  Layer.effect(ClientStore)(makeKeyValue(options));
