/**
 * The atomic batch on the key-value seam (#393). With an `AtomicKeyValue` in
 * context, a durable pull writes its rows, cookie, journal trim and tail release
 * as one batch with no release record, and a push acknowledgement parks and
 * trims as one batch. The tests drive the store over a recording
 * `KeyValueStore` and a test batch that commits or aborts as a transaction
 * would. Without the seam the release-record path is unchanged
 * (unpulled-tail.test.ts).
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { AtomicKeyValue, type KeyValueOp } from "../AtomicKeyValue.js";
import { ClientStore, makeKeyValue, type PullRelease } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { StoreError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Mutation, PatchOp } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

/** An in-memory `KeyValueStore` that records every write, as `set`/`remove` plus the key. */
const recordingKeyValue = () => {
  const data = new Map<string, string>();
  const writes: Array<string> = [];
  const kv = KeyValueStore.make({
    get: (key: string) => Effect.sync(() => data.get(key)),
    getUint8Array: () => Effect.succeed(undefined),
    set: (key: string, value: string | Uint8Array) =>
      Effect.sync(() => {
        writes.push(key);
        data.set(key, String(value));
      }),
    remove: (key: string) =>
      Effect.sync(() => {
        writes.push(key);
        data.delete(key);
      }),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  return { kv, data, writes };
};

/** A store's full contents, sorted, for comparing two stores write for write. */
const contents = (data: ReadonlyMap<string, string>) =>
  [...data.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The test batch: each `apply` either aborts before anything lands (a transaction that failed to
 * commit) or commits every operation. `batches` keeps what each call was handed, for the counts.
 */
interface BatchState {
  abortNext: boolean;
  readonly batches: Array<ReadonlyArray<KeyValueOp>>;
}
const newBatchState = (): BatchState => ({ abortNext: false, batches: [] });

const batchOver = (
  data: Map<string, string>,
  writes: Array<string>,
  state: BatchState
): AtomicKeyValue =>
  AtomicKeyValue.of({
    apply: (ops) =>
      Effect.suspend(() => {
        state.batches.push(ops);
        if (state.abortNext) {
          state.abortNext = false;
          return Effect.fail(new StoreError({ message: "batch aborted" }));
        }
        return Effect.sync(() => {
          for (const op of ops) {
            writes.push(op.key);
            if (op._tag === "Set") data.set(op.key, op.value);
            else data.delete(op.key);
          }
        });
      }),
  });

/** A store over `kv` with the batch in context, or without it when `batch` is undefined. */
const openStore = (kv: KeyValueStore.KeyValueStore, batch?: AtomicKeyValue) => {
  const open = makeKeyValue();
  return batch === undefined
    ? open.pipe(Effect.provideService(KeyValueStore.KeyValueStore, kv))
    : open.pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kv),
        Effect.provideService(AtomicKeyValue, batch)
      );
};

const mutation = (clientId: string, mutationId: number): Mutation => ({
  clientId,
  mutationId,
  mutator: "counter/inc",
  args: { id: "c" },
  createdAt: 0,
});

const put = (id: string, n: number): PatchOp => ({
  _tag: "Put",
  collection: "counters",
  id,
  version: 1,
  value: { id, n },
});

const ROW_A = "legation/row/counters/a";
const ROW_B = "legation/row/counters/b";
const RECORD = "legation/releaseIntent";

/**
 * The engine's pull release on the record path, step for step as `applyPull` runs it without the
 * batch: the record, the rows, the cookie, the journal trim per client, then the tail release.
 */
const pullOnRecordPath = (store: ClientStore, release: PullRelease) =>
  Effect.gen(function* () {
    yield* store.beginRelease(release);
    yield* store.applyRowOps(release.patch);
    if (release.cookie !== undefined) yield* store.setCookie(release.cookie);
    for (const [clientId, upTo] of Object.entries(release.lastMutationIds)) {
      yield* store.acknowledge(clientId, upTo);
    }
    yield* store.releaseUnpulled(release.lastMutationIds);
  });

/** The push acknowledgement's park-then-trim on the record path. */
const acknowledgeOnRecordPath = (
  store: ClientStore,
  parked: ReadonlyArray<Mutation>,
  lastMutationIds: Readonly<Record<string, number>>
) =>
  Effect.gen(function* () {
    yield* store.parkUnpulled(parked);
    for (const [clientId, upTo] of Object.entries(lastMutationIds)) {
      yield* store.acknowledge(clientId, upTo);
    }
  });

// ─── Store level ─────────────────────────────────────────────────────────────

describe("the atomic batch on the key-value store (#393)", () => {
  it.effect("the store takes the batch members only when the seam is in context", () =>
    Effect.gen(function* () {
      const plain = recordingKeyValue();
      const without = yield* openStore(plain.kv);
      expect(without.commitPull).toBeUndefined();
      expect(without.commitAcknowledgement).toBeUndefined();
      expect(without.commitTailRelease).toBeUndefined();

      const batched = recordingKeyValue();
      const withBatch = yield* openStore(
        batched.kv,
        batchOver(batched.data, batched.writes, newBatchState())
      );
      expect(withBatch.commitPull).toBeDefined();
      expect(withBatch.commitAcknowledgement).toBeDefined();
      expect(withBatch.commitTailRelease).toBeDefined();
    })
  );

  it.effect("a durable pull writes each row once and writes no release record", () =>
    Effect.gen(function* () {
      const { kv, data, writes } = recordingKeyValue();
      const state = newBatchState();
      const store = yield* openStore(kv, batchOver(data, writes, state));
      yield* store.appendNext({ clientId: "c", mutator: "counter/inc", args: {}, createdAt: 0 });
      writes.length = 0;
      state.batches.length = 0;

      yield* store.commitPull!({
        lastMutationIds: { c: 1 },
        cookie: "cookie-1",
        patch: [put("a", 1), put("b", 2), put("a", 3)],
      });

      // One batch carries the whole pull: rows, cookie, trim and release.
      expect(state.batches).toHaveLength(1);
      const ops = state.batches.flat();
      const keys = ops.map((op) => op.key);
      expect(keys.filter((key) => key === ROW_A)).toHaveLength(1);
      expect(keys.filter((key) => key === ROW_B)).toHaveLength(1);
      expect(keys).not.toContain(RECORD);
      // Nothing reached the key-value store directly, so no write escaped the batch.
      expect(writes).toEqual(keys);
      // The cookie and the row values are what the pull carried, the last write of `a` winning.
      expect(data.get("legation/cookie")).toBe("cookie-1");
      expect(JSON.parse(data.get(ROW_A) ?? "null")).toEqual({
        id: "a",
        version: 1,
        value: { id: "a", n: 3 },
      });
      expect(yield* store.getCookie).toBe("cookie-1");
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  it.effect("the batch and the record path leave the same store, write for write", () =>
    Effect.gen(function* () {
      // Two stores fed the same history: one commits each step as a batch, the other runs the record
      // path. Their contents must match exactly once the history is done.
      const batched = recordingKeyValue();
      const batchState = newBatchState();
      const batchStore = yield* openStore(
        batched.kv,
        batchOver(batched.data, batched.writes, batchState)
      );
      const recorded = recordingKeyValue();
      const recordStore = yield* openStore(recorded.kv);

      const history = [mutation("c", 1), mutation("c", 2), mutation("c", 3)];
      for (const store of [batchStore, recordStore]) {
        for (const m of history) {
          yield* store.appendMutation(m);
        }
        yield* store.putRow("counters", { id: "a", version: 1, value: { id: "a", n: 0 } });
      }

      // Acknowledge the first two, then release them with a pull; then release the last one by
      // overflow; then a pull that clears the rows.
      yield* batchStore.commitAcknowledgement!(history.slice(0, 2), { c: 2 });
      yield* acknowledgeOnRecordPath(recordStore, history.slice(0, 2), { c: 2 });
      yield* batchStore.commitPull!({
        lastMutationIds: { c: 1 },
        cookie: "k1",
        patch: [put("a", 1), put("b", 2)],
      });
      yield* pullOnRecordPath(recordStore, {
        lastMutationIds: { c: 1 },
        cookie: "k1",
        patch: [put("a", 1), put("b", 2)],
      });
      yield* batchStore.commitTailRelease!({ c: 2 });
      yield* recordStore.beginRelease({ lastMutationIds: { c: 2 }, patch: [] });
      yield* recordStore.releaseUnpulled({ c: 2 });
      yield* batchStore.commitPull!({
        lastMutationIds: { c: 3 },
        cookie: "k2",
        patch: [{ _tag: "Clear" }, put("b", 9)],
      });
      yield* pullOnRecordPath(recordStore, {
        lastMutationIds: { c: 3 },
        cookie: "k2",
        patch: [{ _tag: "Clear" }, put("b", 9)],
      });

      expect(contents(batched.data)).toEqual(contents(recorded.data));
      expect(yield* batchStore.unpulled).toEqual(yield* recordStore.unpulled);
      expect(yield* batchStore.pendingMutations).toEqual(yield* recordStore.pendingMutations);
      expect(yield* batchStore.listRows("counters")).toEqual(
        yield* recordStore.listRows("counters")
      );
      // The batch never wrote a record.
      expect(batched.writes).not.toContain(RECORD);
    })
  );

  it.effect(
    "a batch that aborts leaves the store at its pre-pull state, and a restart keeps the tail",
    () =>
      Effect.gen(function* () {
        const { kv, data, writes } = recordingKeyValue();
        const state = newBatchState();
        const batch = batchOver(data, writes, state);
        const store = yield* openStore(kv, batch);
        const m1 = yield* store.appendNext({
          clientId: "c",
          mutator: "counter/inc",
          args: {},
          createdAt: 0,
        });
        yield* store.commitAcknowledgement!([m1], { c: 1 });
        const before = contents(data);

        state.abortNext = true;
        const pull = yield* Effect.exit(
          store.commitPull!({ lastMutationIds: { c: 1 }, cookie: "k1", patch: [put("a", 5)] })
        );
        expect(Exit.isFailure(pull)).toBe(true);
        // Nothing landed: the same keys hold the same values, and the tail still holds the entry.
        expect(contents(data)).toEqual(before);
        expect(yield* store.unpulled).toEqual([m1]);

        // A restart over the same store shows the tail, not a revert: the entry is still parked.
        const reopened = yield* openStore(kv, batch);
        expect((yield* reopened.unpulled).map((m) => m.mutationId)).toEqual([1]);
        expect(yield* reopened.pendingMutations).toEqual([]);
        expect(yield* reopened.getCookie).toBeUndefined();
      })
  );

  it.effect(
    "a leftover release record from the record path settles on open, with the batch in context",
    () =>
      Effect.gen(function* () {
        const { kv, data, writes } = recordingKeyValue();
        const first = yield* openStore(kv);
        const m1 = yield* first.appendNext({
          clientId: "c",
          mutator: "counter/inc",
          args: {},
          createdAt: 0,
        });
        yield* first.parkUnpulled([m1]);
        // The record path begins a pull and crashes before finishing it.
        yield* first.beginRelease({
          lastMutationIds: { c: 1 },
          cookie: "k1",
          patch: [put("a", 7)],
        });
        expect(data.has(RECORD)).toBe(true);

        const state = newBatchState();
        const reopened = yield* openStore(kv, batchOver(data, writes, state));
        // The open finished the release from its record: the row, the cookie, and the released tail.
        expect(yield* reopened.getCookie).toBe("k1");
        expect(yield* reopened.getRow("counters", "a")).toMatchObject({ value: { id: "a", n: 7 } });
        expect(yield* reopened.unpulled).toEqual([]);
        expect(data.has(RECORD)).toBe(false);
      })
  );

  it.effect("the engine's pull writes each row once through the batch, with no record", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const { kv, data, writes } = recordingKeyValue();
      const state = newBatchState();
      const store = yield* openStore(kv, batchOver(data, writes, state));
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;

      state.batches.length = 0;
      writes.length = 0;
      yield* engine.pull;

      const rowKey = "legation/row/counters/c";
      const keys = state.batches.flat().map((op) => op.key);
      expect(keys.filter((key) => key === rowKey)).toHaveLength(1);
      expect(keys).not.toContain(RECORD);
      expect(writes).not.toContain(RECORD);
      expect(yield* counterValue(engine)).toBe(1);
    })
  );

  it.effect(
    "an engine pull that aborts keeps the effect, and a restart shows the overlay without a revert",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const { kv, data, writes } = recordingKeyValue();
        const state = newBatchState();
        const batch = batchOver(data, writes, state);
        const store = yield* openStore(kv, batch);
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);
        yield* engine.mutate("counter/inc", { id: "c" });
        yield* engine.push;
        expect(yield* tailOf(store)).toEqual(["client-a#1"]);

        state.abortNext = true;
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        const reopened = yield* openStore(kv, batch);
        const restarted = yield* makeCounterEngine(server, reopened);
        yield* restarted.subscribe(countersSubset);
        expect(yield* counterValue(restarted)).toBe(1);
        expect(yield* tailOf(reopened)).toEqual(["client-a#1"]);
        // The next pull reports the entry and releases the tail, with the same value.
        yield* restarted.pull;
        expect(yield* counterValue(restarted)).toBe(1);
        expect(yield* tailOf(reopened)).toEqual([]);
      })
  );
});

// ─── Engine harness (as unpulled-tail.test.ts) ───────────────────────────────

interface Counter {
  readonly id: string;
  readonly n: number;
}

const incrementCounter = <E>(
  writer: {
    readonly get: (collection: string, id: string) => Effect.Effect<unknown, E>;
    readonly put: (collection: string, id: string, value: unknown) => Effect.Effect<void, E>;
  },
  id: string
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const current = (yield* writer.get("counters", id)) as Counter | undefined;
    yield* writer.put("counters", id, { id, n: (current?.n ?? 0) + 1 });
  });

const counterMutators = Mutator.registry([
  {
    mutator: Mutator.make("counter/inc", Schema.Unknown),
    local: (args, writer) => incrementCounter(writer, (args as { readonly id: string }).id),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "counter/inc": (args, writer) => incrementCounter(writer, (args as { readonly id: string }).id),
};

const authPolicy = Authorization.policy({ counters: Authorization.allowAll });
const countersSubset = Subset.make({ collection: "counters" });

const serverOver = (backend: Backend) =>
  Effect.gen(function* () {
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(Authorization.AuthPolicy, authPolicy),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
  });

const makeCounterEngine = (handler: Parameters<typeof makeInMemory>[0], store: ClientStore) =>
  Effect.gen(function* () {
    const transport = yield* makeInMemory(handler, "group-a");
    return yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators: counterMutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const counterValue = (engine: ClientEngineModule.ClientEngine) =>
  engine
    .query(countersSubset)
    .pipe(
      Effect.map((rows) => (rows.find((row) => row.id === "c")?.value as Counter | undefined)?.n)
    );

const tailOf = (store: ClientStore) =>
  store.unpulled.pipe(Effect.map((entries) => entries.map((m) => `${m.clientId}#${m.mutationId}`)));
