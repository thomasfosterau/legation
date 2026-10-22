/**
 * IndexedDB-native ClientStore probe (#158): the measurements behind
 * `docs/indexeddb-native-store.md`. Four sections, each printed as a table
 * at load, plus a handful of timed benches:
 *
 * A. The KeyValueStore-backed `ClientStore` over a byte-counting in-memory
 *    KVS: cold load of a 50k-row collection, write amplification of a pull
 *    touching 1 / 100 / 1 000 rows (row values vs the per-collection id-index
 *    array), and the id-index rewrite cost at 10k / 50k / 200k rows.
 * B. `CollectionIndex`: rebuild time over 50k rows, and an indexed `evaluate`
 *    against a full `Predicate.test` scan for selective predicates.
 * C. `IndexedDbClientStore` (the shipped browser store) over fake-indexeddb:
 *    transaction counts and wall time for seed, cold load and pulls. Timing
 *    here is fake-indexeddb's in-memory scheduling cost, not disk I/O.
 * D. The proposed native schema over raw fake-indexeddb: one object store per
 *    collection, UTF-8 `ArrayBuffer` index keys, `IDBKeyRange` cursor scans,
 *    and one readwrite transaction per pull. Also verifies that bytewise key
 *    order equals code-point order (ADR-0028 rule c).
 *
 * Deterministic (mulberry32, fixed seed). Named `*.bench.ts` so `vitest run`
 * ignores it; run with `vp run bench`. Heap deltas are only meaningful when
 * node exposes `gc` (`NODE_OPTIONS=--expose-gc vp run bench …`).
 *
 * vitest 5 prints a "Benchmark Warning … accessed module export getters too
 * many times" for the `CollectionIndex` benches: the hot loop calls
 * `Predicate.test` / `isNullish` / `compareLiterals` through the module
 * runner's export getters (vitest resolves `@thomasfosterau/legation-effect` to source), so
 * every call pays a getter. The overhead is the same for the scan and the
 * index, so the comparison stands; absolute numbers read slightly high. See
 * https://vitest.dev/guide/benchmarking#module-runner-overhead.
 */
import { describe, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import type * as Ordering from "effect/Ordering";
import { KeyValueStore } from "effect/persistence";
import { IndexedDb } from "@effect/platform-browser";
import { ClientStore, Predicate } from "@thomasfosterau/legation-effect";
import { CollectionIndex, Subset } from "@thomasfosterau/legation-effect/internal";
import type { Protocol } from "@thomasfosterau/legation-effect/internal";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as IndexedDbClientStore from "../IndexedDbClientStore.js";

// ─── Deterministic data ──────────────────────────────────────────────────────

const SEED = 158;
const ROWS = 50_000;
const COLLECTION = "items";

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
type Rng = () => number;
const int = (rng: Rng, max: number) => Math.floor(rng() * max);
const pick = <A>(rng: Rng, xs: ReadonlyArray<A>): A => xs[int(rng, xs.length)]!;

// Mixed BMP and astral text, plus a private-use (U+E000) and a U+FFFD word:
// exactly the characters for which UTF-16 code-unit order and code-point
// order disagree (ADR-0028 rule c).
const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "zulu",
  "Ångström",
  "éclair",
  "日本",
  "한글",
  "𝔘𝔫𝔦",
  "😀smile",
  "🚀rocket",
  "pua",
  "�rep",
];

interface Item {
  readonly id: string;
  readonly name: string;
  readonly qty: number;
  readonly note?: string | null;
  readonly done: boolean;
}

const makeRows = (rng: Rng, count: number): Array<Item> =>
  Array.from({ length: count }, (_, i) => {
    const words = 1 + int(rng, 3);
    const name = Array.from({ length: words }, () => pick(rng, WORDS)).join(" ");
    const noteRoll = rng();
    const base: Item = { id: `r${i}`, name, qty: int(rng, 1000), done: rng() < 0.5 };
    if (noteRoll < 0.1) return base; // absent
    if (noteRoll < 0.4) return { ...base, note: null }; // explicit null
    return { ...base, note: `note ${pick(rng, WORDS)} ${int(rng, 100)}` };
  });

const rows = makeRows(mulberry32(SEED), ROWS);
const putOps = (items: ReadonlyArray<Item>): Array<Protocol.PatchOp> =>
  items.map((row) => ({
    _tag: "Put" as const,
    collection: COLLECTION,
    id: row.id,
    version: 1,
    value: row,
  }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);
/**
 * A UTF-8 `ArrayBuffer` key in this realm's `ArrayBuffer`. Under the jsdom
 * vitest project `TextEncoder` is jsdom's, and its buffer fails
 * fake-indexeddb's `instanceof ArrayBuffer` key check; copying through
 * `Uint8Array` lands the bytes in the realm fake-indexeddb sees.
 */
const keyBytes = (s: string): ArrayBuffer => new Uint8Array(utf8(s)).buffer as ArrayBuffer;
const kb = (bytes: number) => Math.round(bytes / 102.4) / 10;
const ms = (t: number) => Math.round(t * 100) / 100;
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const gcExposed = P.isFunction((globalThis as { gc?: unknown }).gc);
const heap = () => process.memoryUsage().heapUsed;
const timed = async <A>(f: () => Promise<A> | A): Promise<[A, number]> => {
  const t0 = performance.now();
  const result = await f();
  return [result, performance.now() - t0];
};
const median = (xs: ReadonlyArray<number>) => xs.toSorted((a, b) => a - b)[xs.length >> 1]!;

/** UTF-8 byte order is code-point order; JS `<` is UTF-16 code-unit order. */
const compareCodePoints = (a: string, b: string): Ordering.Ordering => {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i === b.length - j ? 0 : a.length - i < b.length - j ? -1 : 1;
};

/** An in-memory KVS that counts `set` calls and UTF-8 bytes written per key. */
const countingStore = () => {
  const data = new Map<string, string>();
  const sets = new Map<string, number>();
  const bytes = new Map<string, number>();
  const store = KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => data.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        sets.set(key, (sets.get(key) ?? 0) + 1);
        bytes.set(key, (bytes.get(key) ?? 0) + utf8(value).byteLength);
        data.set(key, value);
      }),
    remove: (key) => Effect.sync(() => void data.delete(key)),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  const reset = () => {
    sets.clear();
    bytes.clear();
  };
  const summarise = () => {
    let rowSets = 0;
    let rowBytes = 0;
    let otherSets = 0;
    let otherBytes = 0;
    for (const [key, n] of sets) {
      const b = bytes.get(key) ?? 0;
      if (key.startsWith("legation/row/")) {
        rowSets += n;
        rowBytes += b;
      } else {
        otherSets += n;
        otherBytes += b;
      }
    }
    const indexBytes = bytes.get(`legation/rowIndex/${COLLECTION}`) ?? 0;
    return { rowSets, rowBytes, otherSets, otherBytes, indexBytes };
  };
  return { store, data, reset, summarise };
};

const withCounting = <A, E>(
  counting: ReturnType<typeof countingStore>,
  effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>
) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(KeyValueStore.KeyValueStore, counting.store))
  );

// ─── A. KV ClientStore: cold load, write amplification, id-index growth ──────

const sectionA = async () => {
  const counting = countingStore();
  const kv = await withCounting(counting, ClientStore.makeKeyValue());

  const [, seedMs] = await timed(() => withCounting(counting, kv.applyRowOps(putOps(rows))));
  const seeded = counting.summarise();

  // Cold load: every row through the store (Schema-validated envelope), vs a
  // raw JSON.parse over the same strings, so the decode cost is visible.
  gc();
  const h0 = heap();
  const [loaded, loadMs] = await timed(() => withCounting(counting, kv.listRows(COLLECTION)));
  gc();
  const h1 = heap();
  const raw = [...counting.data.entries()].filter(([k]) => k.startsWith("legation/row/"));
  const [parsed, parseMs] = await timed(() => raw.map(([, v]) => JSON.parse(v) as unknown));

  const coldLoad = [
    {
      what: `seed ${ROWS} rows (applyRowOps)`,
      ms: ms(seedMs),
      "row KB": kb(seeded.rowBytes),
      "id-index KB": kb(seeded.indexBytes),
      sets: seeded.rowSets + seeded.otherSets,
    },
    {
      what: `listRows (${loaded.length} rows, Schema envelope)`,
      ms: ms(loadMs),
      "heap delta MB": Math.round(((h1 - h0) / 1048576) * 10) / 10,
      "gc exposed": gcExposed,
    },
    { what: `JSON.parse only (${parsed.length} rows)`, ms: ms(parseMs) },
  ];
  // eslint-disable-next-line no-console
  console.log("A1. KV ClientStore cold load (in-memory KVS)");
  // eslint-disable-next-line no-console
  console.table(coldLoad);

  // Write amplification: a pull touching K existing rows.
  const amplification: Array<Record<string, number | string>> = [];
  for (const k of [1, 100, 1000]) {
    const ops = putOps(rows.slice(0, k));
    counting.reset();
    const [, pullMs] = await timed(() => withCounting(counting, kv.applyRowOps(ops)));
    const s = counting.summarise();
    const total = s.rowBytes + s.otherBytes;
    amplification.push({
      "ops in pull": k,
      "row KB": kb(s.rowBytes),
      "id-index KB": kb(s.indexBytes),
      "total KB": kb(total),
      "amplification ×": Math.round((total / s.rowBytes) * 10) / 10,
      sets: s.rowSets + s.otherSets,
      ms: ms(pullMs),
    });
  }
  // eslint-disable-next-line no-console
  console.log(`A2. Write amplification per pull over a ${ROWS}-row collection`);
  // eslint-disable-next-line no-console
  console.table(amplification);

  // Id-index growth: size of the array value and the cost of one rewrite.
  const growth: Array<Record<string, number | string>> = [];
  for (const n of [10_000, 50_000, 200_000]) {
    const c = countingStore();
    const s = await withCounting(c, ClientStore.makeKeyValue());
    await withCounting(c, s.applyRowOps(putOps(makeRows(mulberry32(SEED + n), n))));
    const one = putOps(rows.slice(0, 1));
    const samples: Array<number> = [];
    for (let i = 0; i < 7; i++) {
      c.reset();
      const [, t] = await timed(() => withCounting(c, s.applyRowOps(one)));
      samples.push(t);
    }
    const sum = c.summarise();
    growth.push({
      rows: n,
      "id-index KB": kb(sum.indexBytes),
      "1-op pull KB": kb(sum.rowBytes + sum.otherBytes),
      "1-op pull ms (median of 7)": ms(median(samples)),
    });
  }
  // eslint-disable-next-line no-console
  console.log("A3. Id-index array as the collection grows (1-op pull = read + rewrite)");
  // eslint-disable-next-line no-console
  console.table(growth);
  return { kv, counting };
};

// ─── B. CollectionIndex: rebuild and indexed evaluate vs full scan ───────────

const storedRows = rows.map((row) => ({ id: row.id, value: row as unknown }));
const rowsById = new Map(storedRows.map((r) => [r.id, r]));
const index = CollectionIndex.empty(["qty", "name", "note"]);

const fullScan = (where: Predicate.Predicate) => {
  const out: Array<{ id: string; value: unknown }> = [];
  for (const row of rowsById.values()) if (Predicate.test(where, row.value)) out.push(row);
  return out;
};

const predicates = {
  "eq qty=42 (~1/1000)": Predicate.eq("qty", 42),
  "qty in [990,995) (~1/200)": Predicate.and(Predicate.gte("qty", 990), Predicate.lt("qty", 995)),
  "name < 'b' (text range)": Predicate.lt("name", "b"),
  "eq qty=42 and done (residual)": Predicate.and(
    Predicate.eq("qty", 42),
    Predicate.eq("done", true)
  ),
} as const;

const sectionB = async () => {
  const tenK = CollectionIndex.empty(["qty", "name", "note"]);
  const [, rebuild10kMs] = await timed(() =>
    CollectionIndex.rebuild(tenK, storedRows.slice(0, 10_000))
  );
  const [, rebuildMs] = await timed(() => CollectionIndex.rebuild(index, storedRows));
  gc();
  const h0 = heap();
  const shadow = CollectionIndex.empty(["qty", "name", "note"]);
  CollectionIndex.rebuild(shadow, storedRows);
  gc();
  const h1 = heap();
  const table: Array<Record<string, number | string>> = [
    { what: "rebuild (3 fields, 10000 rows)", ms: ms(rebuild10kMs) },
    {
      what: `rebuild (3 fields, ${ROWS} rows)`,
      ms: ms(rebuildMs),
      "heap delta MB": Math.round(((h1 - h0) / 1048576) * 10) / 10,
    },
  ];
  for (const [label, where] of Object.entries(predicates)) {
    const scan: Array<number> = [];
    const indexed: Array<number> = [];
    let hits = 0;
    for (let i = 0; i < 9; i++) {
      const [a, ta] = await timed(() => fullScan(where));
      const [b, tb] = await timed(() => CollectionIndex.evaluate(index, rowsById, where));
      if (b === undefined || a.length !== b.length) throw new Error(`mismatch for ${label}`);
      hits = a.length;
      scan.push(ta);
      indexed.push(tb);
    }
    table.push({
      what: label,
      hits,
      "full scan ms": ms(median(scan)),
      "indexed ms": ms(median(indexed)),
    });
  }
  // Sort cost in memory, the fallback when orderBy is not one indexed field.
  const [, sortMs] = await timed(() =>
    storedRows.toSorted((a, b) => compareCodePoints((a.value as Item).name, (b.value as Item).name))
  );
  table.push({ what: `in-memory sort by name, code-point order (${ROWS})`, ms: ms(sortMs) });
  void shadow;
  // eslint-disable-next-line no-console
  console.log("B. CollectionIndex over 50k rows (medians of 9)");
  // eslint-disable-next-line no-console
  console.table(table);
};

// ─── C. IndexedDbClientStore over fake-indexeddb (the shipped layout) ────────

// fake-indexeddb never prunes its per-connection transaction list and filters
// it on every scheduling pass (quadratic in transactions issued), and an
// overwriting `put` walks the whole index to drop the old entry
// (`RecordStore.deleteByValue`). Past ~10k rows the timings measure the fake,
// not IndexedDB, so sections C and D use 10k rows. The transaction counts and
// the correctness checks are exact regardless of size.
const IDB_ROWS = 10_000;
const idbRows = rows.slice(0, IDB_ROWS);

/** Wrap a fake IDBFactory so every transaction is counted. */
const countingFactory = () => {
  const factory = new IDBFactory();
  let transactions = 0;
  const open = factory.open.bind(factory);
  factory.open = (name: string, version?: number) => {
    const request = open(name, version);
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (...args: Parameters<typeof transaction>) => {
        transactions += 1;
        return transaction(...args);
      };
    });
    return request;
  };
  return { factory, count: () => transactions, reset: () => void (transactions = 0) };
};

const sectionC = async () => {
  const counted = countingFactory();
  const layer = IndexedDbClientStore.layer({ database: "kv-layout" }).pipe(
    Layer.provide(
      Layer.succeed(IndexedDb.IndexedDb)(
        IndexedDb.make({ indexedDB: counted.factory, IDBKeyRange })
      )
    )
  );
  const table: Array<Record<string, number | string>> = [];
  const row = (what: string, duration: Duration.Duration) =>
    table.push({ what, transactions: counted.count(), ms: ms(Duration.toMillis(duration)) });
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ClientStore.ClientStore;
      counted.reset();
      const [seedTime] = yield* Effect.timed(store.applyRowOps(putOps(idbRows)));
      row(`seed ${IDB_ROWS} rows`, seedTime);

      for (const k of [1, 100, 1000]) {
        counted.reset();
        const [pullTime] = yield* Effect.timed(store.applyRowOps(putOps(idbRows.slice(0, k))));
        row(`pull touching ${k} rows`, pullTime);
      }
      // The three-step commit the engine performs today (`applyPull`).
      counted.reset();
      const [commitTime] = yield* Effect.timed(
        store
          .applyRowOps(putOps(idbRows.slice(0, 100)))
          .pipe(Effect.andThen(store.acknowledge("c1", 0)), Effect.andThen(store.setCookie("k")))
      );
      row("applyRowOps(100) + acknowledge + setCookie", commitTime);

      counted.reset();
      const [loadTime, loaded] = yield* Effect.timed(store.listRows(COLLECTION));
      row(`cold load listRows (${loaded.length} rows)`, loadTime);
    }).pipe(Effect.provide(layer))
  );
  // eslint-disable-next-line no-console
  console.log("C. IndexedDbClientStore (KV layout) over fake-indexeddb");
  // eslint-disable-next-line no-console
  console.table(table);
};

// ─── D. The proposed native schema over raw fake-indexeddb ───────────────────

interface NativeRecord {
  readonly id: string;
  readonly version: number;
  readonly value: Item;
  /** UTF-8 bytes of `value.name`, the index key (ADR-0028 rule c). */
  readonly k_name: ArrayBuffer;
  readonly k_qty: number;
  /** Present only when `note` is non-null: absent keys are excluded from the index. */
  readonly k_note?: ArrayBuffer;
}

const toRecord = (row: Item): NativeRecord => ({
  id: row.id,
  version: 1,
  value: row,
  k_name: keyBytes(row.name),
  k_qty: row.qty,
  ...(row.note === null || row.note === undefined ? {} : { k_note: keyBytes(row.note) }),
});

const request = <A>(r: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const complete = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
const walk = (
  source: IDBIndex | IDBObjectStore,
  range: IDBKeyRange | null,
  visit: (record: NativeRecord) => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    const r = source.openCursor(range);
    r.onsuccess = () => {
      const cursor = r.result;
      if (cursor === null) return resolve();
      visit(cursor.value as NativeRecord);
      cursor.continue();
    };
    r.onerror = () => reject(r.error);
  });

const openNative = (factory: IDBFactory): Promise<IDBDatabase> => {
  const r = factory.open("native", 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    const items = db.createObjectStore(COLLECTION, { keyPath: "id" });
    items.createIndex("name", "k_name");
    items.createIndex("qty", "k_qty");
    items.createIndex("note", "k_note");
    db.createObjectStore("journal", { keyPath: ["clientId", "mutationId"] });
    db.createObjectStore("meta", { keyPath: "key" });
  };
  return request(r as IDBRequest<IDBDatabase>);
};

const sectionD = async () => {
  const db = await openNative(new IDBFactory());
  const table: Array<Record<string, number | string | boolean>> = [];

  const [, seedMs] = await timed(async () => {
    const tx = db.transaction(COLLECTION, "readwrite");
    const store = tx.objectStore(COLLECTION);
    for (const row of idbRows) store.put(toRecord(row));
    await complete(tx);
  });
  table.push({ what: `seed ${IDB_ROWS} rows, one transaction`, ms: ms(seedMs) });

  const [all, getAllMs] = await timed(() =>
    request(db.transaction(COLLECTION, "readonly").objectStore(COLLECTION).getAll())
  );
  table.push({ what: `cold load getAll (${all.length} rows), one transaction`, ms: ms(getAllMs) });

  // Range scan via an index cursor vs a full object-store cursor with the
  // residual predicate — the evaluation model of the design note.
  const rangeWhere = predicates["qty in [990,995) (~1/200)"];
  const [viaIndex, indexMs] = await timed(async () => {
    const out: Array<NativeRecord> = [];
    const tx = db.transaction(COLLECTION, "readonly");
    await walk(
      tx.objectStore(COLLECTION).index("qty"),
      IDBKeyRange.bound(990, 995, false, true),
      (r) => out.push(r)
    );
    return out;
  });
  const [viaScan, scanMs] = await timed(async () => {
    const out: Array<NativeRecord> = [];
    const tx = db.transaction(COLLECTION, "readonly");
    await walk(tx.objectStore(COLLECTION), null, (r) => {
      if (Predicate.test(rangeWhere, r.value)) out.push(r);
    });
    return out;
  });
  table.push({
    what: "qty in [990,995): index cursor vs full cursor scan",
    hits: viaIndex.length,
    "index ms": ms(indexMs),
    "scan ms": ms(scanMs),
    agree: viaIndex.length === viaScan.length,
  });

  // Text range with a UTF-8 key: bound = utf8("b"), exclusive upper.
  const textWhere = predicates["name < 'b' (text range)"];
  const expectedText = idbRows.filter((r) => Predicate.test(textWhere, r)).length;
  const [textHits, textMs] = await timed(async () => {
    let n = 0;
    const tx = db.transaction(COLLECTION, "readonly");
    await walk(
      tx.objectStore(COLLECTION).index("name"),
      IDBKeyRange.upperBound(keyBytes("b"), true),
      () => void (n += 1)
    );
    return n;
  });
  table.push({
    what: "name < 'b': UTF-8 key upperBound cursor",
    hits: textHits,
    "index ms": ms(textMs),
    agree: textHits === expectedText,
  });

  // Ordered walk of the whole text index: does bytewise key order equal
  // code-point order, and how far does UTF-16 order diverge?
  const [walked, walkMs] = await timed(async () => {
    const names: Array<string> = [];
    const tx = db.transaction(COLLECTION, "readonly");
    await walk(tx.objectStore(COLLECTION).index("name"), null, (r) => names.push(r.value.name));
    return names;
  });
  const byCodePoint = Arr.sort(
    idbRows.map((r) => r.name),
    compareCodePoints
  );
  const byCodeUnit = Arr.sort(
    idbRows.map((r) => r.name),
    Order.String
  );
  const cursorMatchesCodePoint = walked.every((n, i) => n === byCodePoint[i]);
  let divergent = 0;
  for (let i = 0; i < byCodePoint.length; i++) if (byCodePoint[i] !== byCodeUnit[i]) divergent += 1;
  table.push({
    what: `ordered walk of name index (${walked.length} rows)`,
    ms: ms(walkMs),
    "equals code-point order": cursorMatchesCodePoint,
    "positions where UTF-16 order differs": divergent,
  });
  const nullCount = idbRows.filter((r) => r.note === null || r.note === undefined).length;
  const [noteIndexed] = await timed(() =>
    request(db.transaction(COLLECTION, "readonly").objectStore(COLLECTION).index("note").count())
  );
  table.push({
    what: "note index excludes null/absent rows",
    "rows with null/absent note": nullCount,
    "rows in note index": noteIndexed,
    agree: noteIndexed + nullCount === IDB_ROWS,
  });

  // A pull as one transaction across items + journal + meta.
  for (const k of [1, 100, 1000]) {
    const [, pullMs] = await timed(async () => {
      const tx = db.transaction([COLLECTION, "journal", "meta"], "readwrite");
      const items = tx.objectStore(COLLECTION);
      for (const row of idbRows.slice(0, k)) items.put(toRecord(row));
      tx.objectStore("journal").delete(IDBKeyRange.bound(["c1", 0], ["c1", 5]));
      tx.objectStore("meta").put({ key: "cookie", value: `cookie-${k}` });
      await complete(tx);
    });
    table.push({
      what: `pull touching ${k} rows: rows + ack + cookie, one transaction`,
      ms: ms(pullMs),
    });
  }
  // eslint-disable-next-line no-console
  console.log("D. Native schema over raw fake-indexeddb");
  // eslint-disable-next-line no-console
  console.table(table);
  db.close();
};

// ─── Run the tables once at load, then register timed benches ────────────────

const { kv, counting } = await sectionA();
await sectionB();
await sectionC();
await sectionD();

const onePut = putOps(rows.slice(0, 1));
const hundredPuts = putOps(rows.slice(0, 100));
const pointWhere = predicates["eq qty=42 (~1/1000)"];

describe(`KV ClientStore over a ${ROWS}-row collection (in-memory KVS)`, () => {
  test("1-op pull (id-index rewrite dominates)", async ({ bench }) => {
    await bench("1-op pull (id-index rewrite dominates)", async () => {
      await withCounting(counting, kv.applyRowOps(onePut));
    }).run({ time: 500 });
  });
  test("100-op pull", async ({ bench }) => {
    await bench("100-op pull", async () => {
      await withCounting(counting, kv.applyRowOps(hundredPuts));
    }).run({ time: 500 });
  });
  test("cold load listRows", async ({ bench }) => {
    await bench("cold load listRows", async () => {
      await withCounting(counting, kv.listRows(COLLECTION));
    }).run({ time: 1000 });
  });
});

describe(`CollectionIndex over ${ROWS} rows: eq qty=42`, () => {
  // One test, both cases: `bench.compare` runs the scan and the index under
  // the same budget and prints them side by side.
  test("full scan (Predicate.test) vs indexed evaluate", async ({ bench }) => {
    await bench.compare(
      bench("full scan (Predicate.test)", () => void fullScan(pointWhere)),
      bench("indexed evaluate", () => void CollectionIndex.evaluate(index, rowsById, pointWhere)),
      { time: 500 }
    );
  });
  test("Subset.applyIndexed with orderBy name (in-memory sort of hits)", async ({ bench }) => {
    await bench("Subset.applyIndexed with orderBy name (in-memory sort of hits)", () =>
      void Subset.applyIndexed(
        rowsById,
        Subset.make({
          collection: COLLECTION,
          where: pointWhere,
          orderBy: [{ field: "name", direction: "asc" }],
        }),
        index
      )).run({ time: 500 });
  });
});
