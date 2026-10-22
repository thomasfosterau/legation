# IndexedDB-native `ClientStore` with per-collection indexes

**This is a design note, not an ADR.** It answers issue #158 (child of the
façade epic #149): does the durable browser store need to move from a
`KeyValueStore` layout to IndexedDB object stores with native indexes, and
when? It records measurements, a schema, and a recommendation. If the
recommendation's trigger fires, the decision would be written up as an ADR
with the working title "IndexedDB-native `ClientStore`: one object store per
collection, UTF-8 index keys, one transaction per pull", taking the next free
number at that time (ADR-0029 is the façade, #157).

Date: 2026-09-03. Depends on ADR-0028 (filter grammar; rule (c) on text
ordering). Does not change `CollectionIndex` semantics.

## 1. Context

What exists today, with file references.

| Piece                                 | Where                                                                                      | What it does                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClientStore.makeKeyValue` (layout 2) | `packages/effect/src/ClientStore.ts`                                                       | One KVS key per confirmed row (`row/{collection}/{id}`), one id-index array per collection (`rowIndex/{collection}`), one `collections` list, per-mutation journal bodies plus a `journalIndex`, `counters`, and `cookie`. A semaphore serialises writes.                                                                                               |
| `applyRowOps`                         | `ClientStore.ts`, `planRowOps` / `flushCollection`                                         | Groups a patch by collection, writes each row value, then rewrites the whole id-index array once per touched collection (#47).                                                                                                                                                                                                                          |
| `IndexedDbClientStore`                | `packages/browser/src/IndexedDbClientStore.ts`                                             | The KVS store over IndexedDB, opened without a version so a database a later version created still opens (#393): a single object store `entries` keyed by string; every `get`, `set` and `remove` is its own IndexedDB transaction. Its layout is `@effect/platform-browser`'s `BrowserKeyValueStore.layerIndexedDb` layout, whose open pins version 1. |
| `CollectionIndex`                     | `packages/effect/src/CollectionIndex.ts`                                                   | In-memory hash plus sorted runs per indexed field. `plan` splits a top-level `And` into indexable conjuncts and a residual; `evaluate` intersects the indexable hits and runs `Predicate.test` over the residual.                                                                                                                                       |
| Index wiring                          | `packages/effect/src/ClientEngine.ts`, `ensureIndexBuilt` / `updateIndexes` / `applyPatch` | The engine loads a whole collection (`store.listRows`) into an id-keyed map, rebuilds the index from it lazily, and maintains it from patch ops.                                                                                                                                                                                                        |
| The pull commit                       | `ClientEngine.ts`, `applyPull`                                                             | `applyPatch(ops)` then `acknowledge(lastMutationIds)` then `store.setCookie(cookie)`: three separate store calls, each several KVS writes.                                                                                                                                                                                                              |
| Reset path                            | ADR-0008; `KeyValueOptions.storeVersion` (#48)                                             | An unknown or absent cookie makes the server send `Clear` plus full puts. The store-version buster clears rows and the cookie but keeps the journal.                                                                                                                                                                                                    |
| Ordering rule                         | ADR-0028 §2 rule (c), §4                                                                   | Text orders by code point (`COLLATE "C"`). IndexedDB orders strings by UTF-16 code unit, so IndexedDB text keys must be UTF-8 byte arrays. NULL sorts last on `asc`, first on `desc`.                                                                                                                                                                   |

There are no IndexedDB indexes and no `IDBKeyRange` scans anywhere. The
replica is bounded by worker memory, and every pull rewrites one id-index
array per touched collection.

## 2. Measurements

### Method

Everything below comes from
`packages/browser/src/__tests__/native-store.bench.ts` (`vp run bench`),
run on **this CI-class container**: 4 vCPU, 16 GB, Node 22.22.2, Linux.
Numbers are from a run with `NODE_OPTIONS=--expose-gc` so the heap deltas
are real. The data set is deterministic (mulberry32, seed 158): 50 000 rows
of `{ id: "r{i}", name, qty, note?, done }`. `name` is one to three words
drawn from a pool that mixes ASCII, Latin-1, CJK, Hangul, astral characters
(`𝔘𝔫𝔦`, `😀`, `🚀`), a private-use character (U+E000) and U+FFFD. `qty` is an
integer in `[0, 1000)`. `note` is absent for 10 % of rows, `null` for 30 %,
text otherwise. A serialised row is about 114 bytes.

Three environments, and the numbers must not be mixed up:

- **In-memory KVS** (sections A1–A3): the real `ClientStore.makeKeyValue`
  over a `KeyValueStore.makeStringOnly` that counts `set` calls and UTF-8
  bytes. These numbers isolate the store layer's CPU and write volume. They
  contain no I/O.
- **In-memory `CollectionIndex`** (section B): pure engine code.
- **fake-indexeddb 6.2.5** (sections C and D): the shipped
  `IndexedDbClientStore` and a raw probe of the proposed schema. The
  **transaction counts and the correctness checks are exact**. The **wall
  times are not transferable to a browser**: fake-indexeddb keeps a
  per-connection transaction list it never prunes and filters on every
  scheduling pass, and an overwriting `put` walks the whole index
  (`RecordStore.deleteByValue`). A side probe measured 0.044 ms per one-put
  transaction after 1 000 transactions and 0.463 ms after 20 000. Sections C
  and D therefore use 10 000 rows. Browser timings are the one thing this
  note could not measure; see section 8.

fake-indexeddb was already a devDependency of `packages/browser`; no
dependency was added.

### A1. Cold load of a 50k-row collection (in-memory KVS)

| Step                                      |  ms | Bytes written                   | KVS `set` calls | Heap delta |
| ----------------------------------------- | --: | ------------------------------- | --------------: | ---------: |
| Seed 50 000 rows through `applyRowOps`    | 284 | 5 688 KB rows + 429 KB id-index |          50 003 |          — |
| `listRows` (50 000 rows, Schema envelope) | 228 | —                               |               — |    11.2 MB |
| `JSON.parse` only, same 50 000 strings    |  36 | —                               |               — |          — |

The Schema envelope decode is about six times the raw parse. Holding the
decoded rows costs 11.2 MB of heap, about 230 bytes per row.

### A2. Write amplification per pull (50k-row collection, in-memory KVS)

| Ops in pull | Row bytes | Id-index bytes | Total written | Amplification | `set` calls |   ms |
| ----------: | --------: | -------------: | ------------: | ------------: | ----------: | ---: |
|           1 |    0.1 KB |       428.6 KB |      428.7 KB |       4 141 × |           2 | 19.0 |
|         100 |   10.8 KB |       428.6 KB |      439.4 KB |          41 × |         101 | 14.8 |
|       1 000 |  109.8 KB |       428.6 KB |      538.4 KB |         4.9 × |       1 001 | 31.1 |

The id-index array is a fixed 429 KB tax per touched collection per pull,
regardless of how many rows the pull touches. At these id lengths it is
about 8.6 bytes per id; with UUID ids it would be about 39 bytes per id
(1.9 MB at 50k rows).

### A3. The id-index array as the collection grows (in-memory KVS)

| Rows    | Id-index bytes | One 1-op pull writes | 1-op pull, median of 7 |
| ------- | -------------: | -------------------: | ---------------------: |
| 10 000  |          77 KB |                77 KB |                 2.8 ms |
| 50 000  |         429 KB |               429 KB |                16.5 ms |
| 200 000 |       1 845 KB |             1 845 KB |                70.4 ms |

Linear in rows, as designed (#47). The cost is the `JSON.parse`, `Set`
rebuild and `JSON.stringify` of the whole array on every pull.

### B. `CollectionIndex` over 50k rows (in-memory, medians of 9)

| Operation                                           |  Hits | Full scan (`Predicate.test`) | Indexed `evaluate` |
| --------------------------------------------------- | ----: | ---------------------------: | -----------------: |
| `rebuild`, 3 fields, 10 000 rows                    |     — |                            — |              48 ms |
| `rebuild`, 3 fields, 50 000 rows (warm)             |     — |                            — |             958 ms |
| `rebuild`, 3 fields, 50 000 rows (first, cold JIT)  |     — |                            — |           3 109 ms |
| `eq qty=42`                                         |    41 |                      1.91 ms |            0.05 ms |
| `qty >= 990 and qty < 995`                          |   258 |                      3.19 ms |            6.95 ms |
| `name < "b"` (text range)                           | 3 510 |                      3.12 ms |            0.88 ms |
| `eq qty=42 and done=true` (residual)                |    20 |                      2.84 ms |            0.06 ms |
| In-memory sort of 50 000 rows by `name`, code point |     — |                        49 ms |                  — |

Heap held by the three-field index: 15.8 MB, more than the rows themselves.
Two things stand out and neither needs IndexedDB to fix:

- `rebuild` is super-linear: five times the rows costs twenty times the
  time, because `insertSorted` splices into a sorted array. Sorting once
  after collecting would make it `O(n log n)`. At 50k rows the rebuild, not
  the row load, dominates cold start (958 ms versus 228 ms).
- The two-sided range is slower indexed than scanned. `plan` narrows each
  conjunct separately (`qty < 995` yields a 49 750-id `Set`) and intersects.
  Merging same-field bounds into one range would fix it. Both are
  `CollectionIndex` internals, owned by L4, and noted here as findings only.

### C. `IndexedDbClientStore` (the KV layout) over fake-indexeddb, 10k rows

| Operation                                        | IndexedDB transactions |    ms |
| ------------------------------------------------ | ---------------------: | ----: |
| Seed 10 000 rows (`applyRowOps`)                 |                 10 004 |   931 |
| Pull touching 1 row                              |                      4 |   5.8 |
| Pull touching 100 rows                           |                    103 |  25.4 |
| Pull touching 1 000 rows                         |                  1 003 | 287.1 |
| `applyRowOps(100)` + `acknowledge` + `setCookie` |                    106 |  40.0 |
| Cold load `listRows` (10 000 rows)               |                 10 001 | 5 352 |

Transaction counts are structural: one per row read or written, plus the
id-index read and write, the `collections` read, the `journalIndex` read and
write, and the cookie write. A pull touching K rows is K + 6 transactions,
none of them atomic with the others. Cold load is one readonly transaction
per row (the 5.4 s is mostly fake-indexeddb's transaction-list artefact and
should not be read as a browser number).

### D. The proposed native schema over raw fake-indexeddb, 10k rows

| Check or operation                                              | Result                                           |     ms |
| --------------------------------------------------------------- | ------------------------------------------------ | -----: |
| Seed 10 000 rows, one readwrite transaction                     | —                                                |    665 |
| Cold load `getAll`, one readonly transaction                    | 10 000 rows                                      |     49 |
| `qty in [990, 995)`: `IDBKeyRange` cursor on the `qty` index    | 53 hits, agrees with full scan                   |    4.9 |
| Same predicate as a full object-store cursor + `Predicate.test` | 53 hits                                          |  120.4 |
| `name < "b"`: `upperBound(utf8("b"), open)` on the UTF-8 index  | 742 hits, agrees with JS                         |  228.2 |
| Ordered walk of the whole `name` index                          | equals code-point order: true                    |  1 883 |
| Positions where UTF-16 order differs from code-point order      | 5 447 of 10 000                                  |      — |
| `note` index excludes null and absent rows                      | 4 018 null/absent, 5 982 indexed, sums to 10 000 |      — |
| Pull touching 1 row: rows + ack + cookie, one transaction       | —                                                |     27 |
| Pull touching 100 rows, one transaction                         | —                                                |  1 554 |
| Pull touching 1 000 rows, one transaction                       | —                                                | 15 943 |

The correctness rows are the point of this section. Binary keys sort
bytewise, so a UTF-8 `ArrayBuffer` key gives exactly ADR-0028's code-point
order; on this mixed data set, UTF-16 order would have misplaced more than
half the rows. Rows whose key path is missing are silently excluded from an
index, which is how NULL and absent stay out of range indexes without any
special value. The pull timings past 1 row are fake-indexeddb's overwrite
artefact and carry no information about browsers.

## 3. Trigger criteria

Derived from sections A and B. The thresholds are per collection unless
stated. "Fails" means a cost a user notices on every pull or every cold
start, not a correctness failure: the KV layout is correct at any size.

| Trigger                               | Threshold                                                                                               | Basis                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1. Id-index rewrite per pull         | Any collection whose id-index value exceeds **1 MB**, or whose 1-op pull exceeds **50 ms** of store CPU | A3: 429 KB and 16 ms at 50k short ids; 1.8 MB and 70 ms at 200k. Bytes ≈ rows × (id length + 3). 1 MB is about 115k short ids or 27k UUID ids.   |
| T2. Cold start to first indexed query | `listRows` + `rebuild` exceeding **1 s** on desktop-class hardware                                      | A1 + B: 228 ms + 958 ms at 50k rows with three indexed fields. With the `rebuild` fix below the row load alone reaches 1 s at roughly 200k rows. |
| T3. Replica heap                      | Rows plus indexes exceeding **100 MB** in the worker                                                    | A1 + B: 11 MB rows + 16 MB index at 50k rows and three fields, so about 27 MB per 50k rows; 100 MB is about 200k indexed rows.                   |
| T4. Torn reads across a pull          | A consumer that must observe a pull's rows, the journal trim and the cookie as one snapshot             | Section 6. Not a size threshold; a correctness need that no amount of tuning of the KV layout can meet.                                          |

Any one of T1–T4 being reached by a real app is the signal to build. Before
that, two cheaper changes remove most of the measured pain without a second
store implementation: sort-once `rebuild` in `CollectionIndex` (B), and
chunking the id-index array in the KV layout (for example 1 024 ids per
`rowIndex/{collection}/{chunk}` key) so a pull rewrites one chunk, not the
collection. Neither is in scope here; both are named so the trigger is not
reached for want of a small fix.

## 4. Schema

One IndexedDB database per client store (versioned), with:

- **One object store per collection**, named by the collection, `keyPath:
  "id"`. Records are `{ id, version, value, k_<field>… }`: the `StoredRow`
  envelope plus one derived key field per indexed field, computed by the
  store on write. IndexedDB cannot compute keys, so the writer materialises
  them; the engine's row values stay `Unknown` and untouched (ADR-0014).
- **Indexed fields** are `Node.indexes` ∪ sortable fields ∪ filterable fields
  that admit a range (per-attribute `filterable`/`sortable`, effect-jsonapi
  #84). Each has one index, `createIndex(field, ["k_<field>", "k_id"])`: a
  compound key of the encoded value and the encoded id, so cursor order is
  `(value, id)` and equals `Subset.comparator`'s id tie-break exactly.
- **Key encoding**, one function shared by the writer and the planner:

  | Literal kind (ADR-0028 §4) | IndexedDB key                   | Why                                                                                                                         |
  | -------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | `text`, `instant`, the id  | UTF-8 bytes as an `ArrayBuffer` | Binary keys compare bytewise; UTF-8 byte order is code-point order, which is `COLLATE "C"` (rule c). Section D verifies it. |
  | `integer`, `double`        | the number                      | Numeric key order.                                                                                                          |
  | `boolean`                  | `0` or `1`                      | Booleans are not valid IndexedDB keys; `false < true` matches Postgres.                                                     |
  | NULL or absent             | no `k_<field>` property         | A record whose key path is missing is excluded from that index (rule b: absent ≡ NULL).                                     |

- **An `isnull` index per nullable indexed field**: `k_<field>_null` holds
  the encoded id and is present only when the field is NULL or absent. `IsNull`
  reads it directly; the writer of the range index never sees these rows.
- **`journal`** object store, `keyPath: ["clientId", "mutationId"]`, one
  record per pending mutation. `acknowledge(clientId, upTo)` is one
  `delete(IDBKeyRange.bound([clientId, 0], [clientId, upTo]))`.
  `pendingCount` (#260) is one `journal.count()`, reading no records.
- **`meta`** object store keyed by name: `cookie`, `counters`, `layout`,
  `storeVersion`.

Producing NULL ordering from cursors: `asc` walks the field index with
`"next"` and then the `isnull` index with `"next"` (NULLs last, id order);
`desc` walks the `isnull` index with `"prev"` and then the field index with
`"prev"` (NULLs first). Both match ADR-0028 §4.

Strict bounds on the compound key use the key-type order (binary < array):
`field > v` is `lowerBound([enc(v), []])` because the empty array sorts after
every `[enc(v), idBytes]`; `field < v` is `upperBound([enc(v)], true)` because
the one-element prefix sorts before every `[enc(v), idBytes]`.

## 5. Evaluation

`CollectionIndex.plan`'s split is reused as the planner's shape: the top-level
`And` is decomposed into indexable conjuncts and a residual predicate. The
difference is that IndexedDB has no cheap set intersection, so exactly one
indexable conjunct drives a cursor and everything else is residual.

1. Choose the driving conjunct. Prefer `eq` or `In` on an indexed field (one
   cursor per value, `IDBKeyRange.only`); else the narrowest range, merging
   two bounds on the same field into one `IDBKeyRange.bound`; `IsNull` drives
   the `isnull` index. `index.count(range)` is cheap and can pick the
   narrowest when several qualify.
2. Open a cursor on that index with the range. Run
   `Predicate.evaluate` (three-valued, root `getOrElse(false)`, ADR-0028) on
   each record's `value` for the residual. No indexable conjunct at all means
   a full object-store cursor with the whole predicate as residual, which is
   the same fallback `Subset.applyIndexed` takes today.
3. Sort. If `orderBy` is a single indexed field, open the cursor on that field's
   index instead (direction `"next"` or `"prev"`, NULL handling per section 4)
   and apply the `where` entirely as residual; the cursor delivers rows in
   final order, so `limit` and cursor pagination can stop early with
   `cursor.advance`. Otherwise collect the candidates and `toSorted` with
   `Subset.comparator` in memory (49 ms for all 50k rows in B; far less for
   a filtered set).
4. Window with `limit` and `cursor` as `Subset.apply` does today.

Semantics never move: `Predicate.evaluate` and `Subset.comparator` remain the
JS implementation of ADR-0028, and the differential harness (#153) with
Postgres as oracle is what proves the IndexedDB evaluator agrees, exactly as
it does for the SQL compilers.

## 6. Atomicity

Today `applyPull` runs `applyRowOps`, `acknowledge` and `setCookie` as three
store calls, each of which is several KVS writes and, on IndexedDB, several
transactions (K + 6 for a K-row pull, section C). A service worker can be
killed between any two of them (ADR-0010). The crash windows and why the
current design survives them:

| Crash after                                  | State left behind                                            | Why it is safe today                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Some row values, before the id-index rewrite | New rows exist under `row/…` but are invisible to `listRows` | The cookie is unchanged, so the next pull re-sends the same patch; puts are idempotent and the index rewrite catches up.                                 |
| `applyRowOps`, before `acknowledge`          | Rows confirmed; acknowledged mutations still in the journal  | They are re-pushed; the backend's `lastMutationId` makes re-application a no-op (ADR-0008), and the next ack trims them.                                 |
| `acknowledge`, before `setCookie`            | Journal trimmed; cookie stale                                | The next pull re-sends the patch. Idempotent again.                                                                                                      |
| Mid-`Clear` (`clearRowsInner`)               | Some collections wiped, others not                           | The cookie is unchanged, so the reset patch is re-sent in full.                                                                                          |
| Mid-`acknowledge` (#294)                     | Some acknowledged bodies removed; the index still lists them | Reads skip a missing body; the next open drops those index entries (their ids already reserved), so `pendingCount` and the high-water check agree again. |
| Mid-`compactPending` (#249)                  | Journal bodies, index and counter partly rewritten           | A write-ahead `compactionIntent` is the commit point; it is rolled forward on the next open (see below).                                                 |

Paced compaction (#117, #249) is the one journal write that is neither a
prefix trim nor idempotent by construction: it drops superseded unpushed
entries and renumbers the survivors, rewriting several bodies, the
`journalIndex` and `counters`. The KV store makes it crash-safe with a
write-ahead record, `compactionIntent`, holding the complete outcome (stale
body ids, the renumbered bodies, the new index, the new counter): the intent
write is the commit point, applying it is a sequence of idempotent steps, and
`makeKeyValue` (and any journal operation on a live store that finds one
pending) rolls it forward before doing anything else. A crash or an error
before the commit leaves the old contiguous journal; after it, the new one,
and `compactPending` reports the committed renumbering to its caller even if
applying it failed. The native schema replaces the intent with one readwrite
transaction over `journal` and `meta`, and `compactPending` keeps its
contract. A per-client `sentUpTo` watermark (`markSent`, a `meta` entry in the
native schema) marks the entries a push attempt may have sent; compaction
never drops or renumbers at or below it.

Idempotent patches paper over every window as long as the server re-sends
the same patch for the same cookie. What they cannot give is **snapshot
isolation for concurrent readers**: while a K-row pull is being written, a
reader (the façade of #149 answering a fetch from the replica, or a mirror
hydrating) can observe row A updated and row B not, or rows updated while
the journal still holds the mutations that produced them, so the overlay
replays effects that are already confirmed. ADR-0008's "reveal atomically"
holds for in-process observers via `publishChange`, not for anyone reading
the store directly.

With the native schema the three calls become **one readwrite transaction**
over the touched collection stores plus `journal` and `meta`. IndexedDB
transactions are atomic and durable on commit, so a crash leaves either the
old or the new state, and readers see one or the other. This needs a
`ClientStore` interface addition, something like
`commitPull({ ops, lastMutationIds, cookie })`, which the memory and KV
stores implement as today's three steps and the native store as one
transaction; the engine's `applyPull` calls it instead of the three
methods. The scope of the transaction is known up front from `planRowOps`
(a `Clear` scopes every collection store).

## 7. Migration

- **Database version bump.** The native store is a new IndexedDB database
  (or a new version of the KVS one with new object stores; a new database
  keeps the two layouts independent and lets the old one be deleted after a
  successful first open). `meta.layout` is stamped on open as `__layout` is
  today.
- **Rows and cookie: rehydrate via ADR-0008's reset path.** Do not copy
  rows. Open the new database empty with no cookie; the next pull is `Clear`
  plus full puts. This is the precedent set by the rename changeset
  (`.changeset/rename-to-legation.md`: the key prefix changed, old state was
  orphaned, clients rehydrated via a full pull) and by the store-version
  buster (#48).
- **Journal and counters: carry across.** Pending intents are the user's
  unsynced work and must survive, exactly as #48 preserves them. `counters`
  must also carry across: a fresh `nextMutationId` would reissue ids the
  backend has already applied, and those mutations would be silently
  dropped as duplicates. On first open of the native store, if the KVS
  database exists, copy `journal/*` bodies and `counters`, then delete the
  KVS database.
- **Same reset semantics for the `storeVersion` buster** (rows and cookie
  cleared, journal kept) so app-level cache busting behaves identically on
  both stores.

## 8. Recommendation

**Defer, with a named trigger.** Do not build the native store now, and do
not build it behind a flag.

Reasoning tied to the numbers and to the façade's needs:

- **The KV layout does not fail at the sizes anything reaches.** At 50k rows
  a pull costs 15–31 ms of store CPU and rewrites 429 KB (A2), cold load is
  228 ms (A1) and the replica holds 27 MB (A1 + B). Those are noticeable but
  not failures, and the largest of them, the 958 ms `rebuild`, is a
  `CollectionIndex` algorithm issue with a one-line fix, not a storage issue.
- **The example apps are three orders of magnitude below the thresholds.**
  The seeds are 56 rows (northwind), 23 (commerce), a handful (realworld,
  todo). The façade (#149) serves reads from the replica, and the replica is
  bounded by explicit subscriptions with windows; a subscription that would
  pull 100k rows into a browser is a subscription design problem before it
  is a storage problem. ADR-0027 §2's law that sync windows stay narrow
  works in this design's favour.
- **The planner split already exists at an in-memory seam.** Section 5 is a
  reuse of `CollectionIndex.plan`'s shape, not new theory. Building it as a
  second `ClientStore` behind the same interface is straightforward but is
  a second implementation to keep exact against the harness (#153), plus a
  migration, plus browser-only testing. That cost is worth paying when a
  trigger fires, not speculatively.
- **The browser target stays first-class without it.** ADR-0028 §6 names
  IndexedDB as a target; today that target is served by `Predicate.evaluate`
  and `Subset.comparator` over the in-memory replica, which are themselves
  ADR-0028 implementations under the same harness. Nothing in ADR-0028 is
  left unimplemented by deferring; rule (c)'s "IndexedDB keys must be UTF-8
  bytes" applies to the native store when it is built, and section 4 records
  how.
- **Behind a flag is the worst of both.** A flagged store still has to be
  exact, migrated and tested, and the flag's off state is the KV layout that
  already works.

The trigger, restated: build when a real app hits **T1** (an id-index value
over 1 MB, about 115k short-id or 27k UUID-id rows in one collection), **T2**
(over 1 s cold start after the `rebuild` fix), **T3** (over 100 MB replica
heap in the worker), or **T4** (a consumer that needs snapshot-isolated reads
of the store across a pull; ADR-0029 has the façade answer through the
engine's view, the same one `Client.query` uses, never the store directly,
so the façade as designed does not fire it). Before any of those,
the two small fixes named in section 3 should be filed under
`CollectionIndex` and the KV layout respectively.

Because the recommendation is not "build", no follow-up implementation issue
is filed. Appendix B holds the specification the issue would carry so it is
not lost.

## Appendix A. Reproducing the numbers

```
pnpm install
NODE_OPTIONS=--expose-gc vp test bench --run packages/browser/src/__tests__/native-store.bench.ts --project node
```

Without `--expose-gc` the tables still print but the heap deltas are noise.
The bench also runs under the `svelte` (jsdom) project in a plain
`vp run bench`; the numbers there are the same code on the same runtime.

## Appendix B. The implementation issue, if a trigger fires

**Title:** IndexedDB-native `ClientStore`: one object store per collection,
UTF-8 index keys, one transaction per pull

**Body (spec):**

- Package: `@thomasfosterau/legation-browser`, new module `NativeIndexedDbClientStore`,
  same `ClientStore` interface plus `commitPull`.
- Schema exactly as section 4 of `docs/indexeddb-native-store.md`: one
  object store per collection keyed by `id`; compound indexes
  `[k_<field>, k_id]` on `Node.indexes` ∪ sortable ∪ filterable-with-range;
  text and instants as UTF-8 `ArrayBuffer`, booleans as 0/1, NULL and absent
  excluded with a separate `isnull` index; `journal` and `meta` stores.
- Evaluation as section 5: reuse of `CollectionIndex.plan`'s split; one
  driving `IDBKeyRange` cursor; residual via `Predicate.evaluate`; sort by an
  index cursor when `orderBy` is one indexed field, else in memory.
- Atomicity as section 6: `commitPull` is one readwrite transaction; the
  memory and KV stores implement it as the existing three steps.
- Migration as section 7: new database, rows and cookie rehydrate via the
  reset path, journal and counters copied across, old database deleted.
- Acceptance: the differential harness (#153) green with the native store as
  a subject; `keyvalue-client-store.test.ts` and
  `indexeddb-client-store.test.ts` equivalents pass against it; the bench in
  Appendix A extended with real-browser numbers (Playwright or WebDriver)
  for cold load, K-row pulls and a range cursor at 50k rows; a changeset
  noting the rehydrate-on-upgrade.
- Out of scope: `CollectionIndex` semantics (L4); the wire protocol.
