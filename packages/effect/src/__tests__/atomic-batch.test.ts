/**
 * The atomic batch on the key-value seam. With an `AtomicKeyValue` in
 * context, a durable pull writes its rows, cookie, journal trim and tail release
 * as one batch with no release record, and a push acknowledgement parks and
 * trims as one batch. The tests drive the store over a recording
 * `KeyValueStore` and a test batch that commits or aborts as a transaction
 * would. Without the seam the release-record path is unchanged
 * (unpulled-tail.test.ts).
 */
import * as P from "effect/Predicate";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
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
import { defined } from "./defined.js";
import { TestFailure } from "./test-failure.js";
import * as Json from "../internal/Json.js";
import { idOf, optionalCountOf } from "./shapes.js";
import { ClientGroupId, MutationId, RowId } from "../Protocol.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

/**
 * An in-memory `KeyValueStore` that records every write, as `set`/`remove` plus the key. `failGets`
 * holds keys whose next `get` fails once, so a test can make one read fail and nothing else.
 */
const recordingKeyValue = () => {
  const data = MutableHashMap.empty<string, string>();
  const writes: Array<string> = [];
  const failGets = MutableHashSet.empty<string>();
  const kv = KeyValueStore.make({
    get: (key: string) =>
      Effect.suspend(() => {
        if (MutableHashSet.has(failGets, key)) {
          MutableHashSet.remove(failGets, key);
          return Effect.fail(
            new KeyValueStore.KeyValueStoreError({ method: "get", message: `get "${key}" failed` })
          );
        }
        return Effect.sync(() => Option.getOrUndefined(MutableHashMap.get(data, key)));
      }),
    getUint8Array: () => Effect.undefined,
    set: (key: string, value: string | Uint8Array) =>
      Effect.sync(() => {
        writes.push(key);
        MutableHashMap.set(data, key, String(value));
      }),
    remove: (key: string) =>
      Effect.sync(() => {
        writes.push(key);
        MutableHashMap.remove(data, key);
      }),
    clear: Effect.sync(() => MutableHashMap.clear(data)),
    size: Effect.sync(() => MutableHashMap.size(data)),
    keys: Effect.sync(() => [...MutableHashMap.keys(data)]),
  });
  return { kv, data, writes, failGets };
};

/** A store's full contents, sorted, for comparing two stores write for write. */
const contents = (data: MutableHashMap.MutableHashMap<string, string>) =>
  [...data].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The test batch: each `apply` either aborts before anything lands (a transaction that failed to
 * commit) or commits every operation. `batches` keeps what each call was handed, for the counts.
 */
interface BatchState {
  abortNext: boolean;
  /** The next batch commits, then reports a failure: an outcome the caller cannot tell from an abort. */
  commitThenFailNext: boolean;
  /** Runs after each batch commits, before it reports success. */
  afterCommit?: (() => void) | undefined;
  /** Each call's operations, in the order the calls were made. */
  readonly batches: Array<ReadonlyArray<KeyValueOp>>;
}
const newBatchState = (): BatchState => ({
  abortNext: false,
  commitThenFailNext: false,
  batches: [],
});

const batchOver = (
  data: MutableHashMap.MutableHashMap<string, string>,
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
        const commit = Effect.sync(() => {
          Arr.forEach(ops, (op) => {
            writes.push(op.key);
            if (P.isTagged(op, "Set")) MutableHashMap.set(data, op.key, op.value);
            else MutableHashMap.remove(data, op.key);
          });
          state.afterCommit?.();
        });
        if (state.commitThenFailNext) {
          state.commitThenFailNext = false;
          return commit.pipe(
            Effect.andThen(Effect.fail(new StoreError({ message: "batch failed after commit" })))
          );
        }
        return commit;
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
  mutationId: MutationId.make(mutationId),
  mutator: "counter/inc",
  args: { id: "c" },
  createdAt: 0,
});

const put = (id: string, n: number): PatchOp => ({
  _tag: "Put",
  collection: "counters",
  id: RowId.make(id),
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
    yield* Effect.forEach(
      R.toEntries(release.lastMutationIds),
      ([clientId, upTo]) => store.acknowledge(clientId, upTo),
      { concurrency: 1, discard: true }
    );
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
    yield* Effect.forEach(
      R.toEntries(lastMutationIds),
      ([clientId, upTo]) => store.acknowledge(clientId, upTo),
      { concurrency: 1, discard: true }
    );
  });

// ─── Store level ─────────────────────────────────────────────────────────────

describe("the atomic batch on the key-value store", () => {
  it.effect("the store takes the batch members only when the seam is in context", () =>
    Effect.gen(function* () {
      const plain = recordingKeyValue();
      const without = yield* openStore(plain.kv);
      expect(without.commitPull).toBeUndefined();
      expect(without.commitAcknowledgement).toBeUndefined();

      const batched = recordingKeyValue();
      const withBatch = yield* openStore(
        batched.kv,
        batchOver(batched.data, batched.writes, newBatchState())
      );
      expect(withBatch.commitPull).toBeDefined();
      expect(withBatch.commitAcknowledgement).toBeDefined();
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

      yield* defined(store.commitPull)({
        lastMutationIds: { c: 1 },
        cookie: "cookie-1",
        patch: [put("a", 1), put("b", 2), put("a", 3)],
      });

      // One batch carries the whole pull: rows, cookie, trim and release.
      expect(state.batches).toHaveLength(1);
      const ops = state.batches.flat();
      const keys = ops.map((op) => op.key);
      // Three patch ops touch two rows, and the batch carries one operation per distinct key.
      expect(keys).toHaveLength(Arr.dedupe(keys).length);
      expect(keys.filter((key) => key === ROW_A)).toHaveLength(1);
      expect(keys.filter((key) => key === ROW_B)).toHaveLength(1);
      expect(keys).not.toContain(RECORD);
      // Nothing reached the key-value store directly, so no write escaped the batch.
      expect(writes).toEqual(keys);
      // The cookie and the row values are what the pull carried, the last write of `a` winning.
      expect(Option.getOrUndefined(MutableHashMap.get(data, "legation/cookie"))).toBe("cookie-1");
      expect(Json.parse(Option.getOrUndefined(MutableHashMap.get(data, ROW_A)) ?? "null")).toEqual({
        id: "a",
        version: 1,
        value: { id: "a", n: 3 },
      });
      expect(yield* store.getCookie).toBe("cookie-1");
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  it.effect("the batch and the record path leave the same final contents", () =>
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
      yield* Effect.forEach(
        [batchStore, recordStore],
        (store) =>
          Effect.gen(function* () {
            yield* Effect.forEach(history, (m) => store.appendMutation(m), {
              concurrency: 1,
              discard: true,
            });
            yield* store.putRow("counters", {
              id: RowId.make("a"),
              version: 1,
              value: { id: "a", n: 0 },
            });
          }),
        { concurrency: 1, discard: true }
      );

      // Acknowledge the first two, then release them with a pull; then release the last one with a
      // pull; then a pull that clears the rows.
      yield* defined(batchStore.commitAcknowledgement)(history.slice(0, 2), { c: 2 });
      yield* acknowledgeOnRecordPath(recordStore, history.slice(0, 2), { c: 2 });
      yield* defined(batchStore.commitPull)({
        lastMutationIds: { c: 1 },
        cookie: "k1",
        patch: [put("a", 1), put("b", 2)],
      });
      yield* pullOnRecordPath(recordStore, {
        lastMutationIds: { c: 1 },
        cookie: "k1",
        patch: [put("a", 1), put("b", 2)],
      });
      yield* defined(batchStore.commitPull)({ lastMutationIds: { c: 2 }, patch: [] });
      yield* recordStore.beginRelease({ lastMutationIds: { c: 2 }, patch: [] });
      yield* recordStore.releaseUnpulled({ c: 2 });
      yield* defined(batchStore.commitPull)({
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
        yield* defined(store.commitAcknowledgement)([m1], { c: 1 });
        const before = contents(data);

        state.abortNext = true;
        const pull = yield* Effect.exit(
          defined(store.commitPull)({
            lastMutationIds: { c: 1 },
            cookie: "k1",
            patch: [put("a", 5)],
          })
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
        expect(MutableHashMap.has(data, RECORD)).toBe(true);

        const state = newBatchState();
        const reopened = yield* openStore(kv, batchOver(data, writes, state));
        // The open finished the release from its record: the row, the cookie, and the released tail.
        expect(yield* reopened.getCookie).toBe("k1");
        expect(yield* reopened.getRow("counters", RowId.make("a"))).toMatchObject({
          value: { id: "a", n: 7 },
        });
        expect(yield* reopened.unpulled).toEqual([]);
        expect(MutableHashMap.has(data, RECORD)).toBe(false);
      })
  );

  it.effect(
    "a batch pull finishes an outstanding release record, so a later write cannot replay it",
    () =>
      Effect.gen(function* () {
        const { kv, data, writes, failGets } = recordingKeyValue();
        const state = newBatchState();
        const store = yield* openStore(kv, batchOver(data, writes, state));
        // A record-path pull begins and is never finished: its record stays outstanding.
        yield* store.beginRelease({ lastMutationIds: {}, cookie: "k1", patch: [put("a", 1)] });
        expect(MutableHashMap.has(data, RECORD)).toBe(true);
        // The next read of the record fails, so the row write that would finish it fails too.
        MutableHashSet.add(failGets, RECORD);
        const failed = yield* Effect.exit(
          store.putRow("counters", { id: RowId.make("b"), version: 1, value: { id: "b", n: 0 } })
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(MutableHashMap.has(data, RECORD)).toBe(true);

        // A newer pull commits. It finishes the stale record before it writes, so the record is not
        // left to replay over the batch's rows and cookie.
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "k2",
          patch: [put("a", 2)],
        });
        // A later row write finishes whatever is still outstanding.
        yield* store.putRow("counters", {
          id: RowId.make("c"),
          version: 1,
          value: { id: "c", n: 0 },
        });

        expect(
          Json.parse(Option.getOrUndefined(MutableHashMap.get(data, ROW_A)) ?? "null")
        ).toMatchObject({ value: { n: 2 } });
        expect(Option.getOrUndefined(MutableHashMap.get(data, "legation/cookie"))).toBe("k2");
        expect(MutableHashMap.has(data, RECORD)).toBe(false);
      })
  );

  // Each batch member finishes an outstanding record before it writes. The record's read is made to
  // fail, so the batch must fail with nothing written: a finish that cannot read the record is not
  // skipped. Each member writes something here, so a member that skipped the finish would show it.
  const batchMemberCalls: ReadonlyArray<
    readonly [string, (store: ClientStore) => Effect.Effect<void, StoreError>]
  > = [
    [
      "commitPull",
      (store) =>
        defined(store.commitPull)({ lastMutationIds: {}, cookie: "k2", patch: [put("a", 2)] }),
    ],
    [
      "commitAcknowledgement",
      (store) => defined(store.commitAcknowledgement)([mutation("c", 2)], {}),
    ],
  ];
  Arr.forEach(batchMemberCalls, ([member, call]) => {
    it.effect(
      `${member} finishes an outstanding release record first, or fails with nothing written`,
      () =>
        Effect.gen(function* () {
          const { kv, data, writes, failGets } = recordingKeyValue();
          const state = newBatchState();
          const store = yield* openStore(kv, batchOver(data, writes, state));
          // An entry on the tail for the release to trim, then a record-path release left outstanding.
          yield* store.parkUnpulled([mutation("c", 1)]);
          yield* store.beginRelease({ lastMutationIds: {}, cookie: "k1", patch: [put("a", 1)] });
          const before = contents(data);
          MutableHashSet.add(failGets, RECORD);

          const attempt = yield* Effect.exit(call(store));
          expect(Exit.isFailure(attempt)).toBe(true);
          expect(contents(data)).toEqual(before);
          expect(state.batches).toHaveLength(0);
          expect(MutableHashMap.has(data, RECORD)).toBe(true);
        })
    );
  });

  it.effect("a store written through the batch reads back on the record path", () =>
    Effect.gen(function* () {
      const { kv, data, writes } = recordingKeyValue();
      const state = newBatchState();
      const batched = yield* openStore(kv, batchOver(data, writes, state));
      const m1 = yield* batched.appendNext({
        clientId: "c",
        mutator: "counter/inc",
        args: {},
        createdAt: 0,
      });
      yield* defined(batched.commitAcknowledgement)([m1], { c: 1 });
      yield* defined(batched.commitPull)({
        lastMutationIds: { c: 1 },
        cookie: "k1",
        patch: [put("a", 4)],
      });

      // Reopened without the seam, the record path reads what the batch wrote and keeps working.
      const recordPath = yield* openStore(kv);
      expect(yield* recordPath.getCookie).toBe("k1");
      expect(yield* recordPath.getRow("counters", RowId.make("a"))).toMatchObject({
        value: { n: 4 },
      });
      expect(yield* recordPath.unpulled).toEqual([]);
      expect(yield* recordPath.pendingMutations).toEqual([]);
      yield* pullOnRecordPath(recordPath, {
        lastMutationIds: {},
        cookie: "k2",
        patch: [put("a", 9)],
      });
      expect(yield* recordPath.getCookie).toBe("k2");
      expect(yield* recordPath.getRow("counters", RowId.make("a"))).toMatchObject({
        value: { n: 9 },
      });
      expect(MutableHashMap.has(data, RECORD)).toBe(false);
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
      // One batch for the whole pull, and within it one operation per key, so no row is written twice.
      expect(state.batches).toHaveLength(1);
      const keys = state.batches.flat().map((op) => op.key);
      expect(keys).toHaveLength(Arr.dedupe(keys).length);
      expect(keys.filter((key) => key === rowKey)).toHaveLength(1);
      expect(keys).not.toContain(RECORD);
      expect(writes).not.toContain(RECORD);
      expect(yield* counterValue(engine)).toBe(1);
    })
  );

  it.effect(
    "a pull whose batch commits and then reports a failure leaves the engine's view as the store holds it",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const { kv, data, writes } = recordingKeyValue();
        const state = newBatchState();
        const store = yield* openStore(kv, batchOver(data, writes, state));
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);
        yield* engine.mutate("counter/inc", { id: "c" });
        yield* engine.push;
        expect(yield* tailOf(store)).toEqual(["client-a#1"]);

        // A second client's increment reaches the server too, so the pull that follows carries a row
        // the first client's tail does not account for.
        const other = yield* makeCounterEngine(server, yield* openStore(recordingKeyValue().kv), {
          clientId: "client-b",
          group: "group-b",
        });
        yield* other.subscribe(countersSubset);
        yield* other.mutate("counter/inc", { id: "c" });
        yield* other.push;

        // The pull's batch commits, then reports a failure: the store holds the pull, and the caller
        // cannot tell that from a failed batch.
        state.commitThenFailNext = true;
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        const row = yield* store.getRow("counters", RowId.make("c"));
        expect(row).toMatchObject({ value: { id: "c", n: 2 } });
        expect(yield* tailOf(store)).toEqual([]);
        // The engine's view is the store's: the released tail is not replayed over the committed row.
        expect(yield* counterValue(engine)).toBe(2);
      })
  );

  it.effect(
    "a pull that dies after its batch commits, in the engine's own steps, leaves the view as the store holds it",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const { kv, data, writes } = recordingKeyValue();
        const state = newBatchState();
        const store = yield* openStore(kv, batchOver(data, writes, state));
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);
        yield* engine.mutate("counter/inc", { id: "c" });
        yield* engine.push;
        expect(yield* tailOf(store)).toEqual(["client-a#1"]);

        // A second client's increment reaches the server too, so the pull carries a row the first
        // client's tail does not account for.
        const other = yield* makeCounterEngine(server, yield* openStore(recordingKeyValue().kv), {
          clientId: "client-b",
          group: "group-b",
        });
        yield* other.subscribe(countersSubset);
        yield* other.mutate("counter/inc", { id: "c" });
        yield* other.push;

        // Once the batch has committed, the engine's first wall-clock read is the settle of its own
        // mutations, a step that runs after the commit in the engine itself. That read dies once. The
        // commit is durable, so the view must end on the store's row, not on the tail replayed over it.
        const died = { count: 0 };
        let armed = false;
        state.afterCommit = () => {
          armed = true;
        };
        const dieOnceAfterCommit = yield* Effect.clockWith((real) =>
          Effect.succeed<Clock.Clock>({
            currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe(),
            currentTimeMillis: Effect.suspend(() => {
              if (!armed) return real.currentTimeMillis;
              armed = false;
              died.count += 1;
              return Effect.die(new TestFailure({ message: "the pull died after its commit" }));
            }),
            currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe(),
            currentTimeNanos: real.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: real.monotonicTimeNanos,
            sleep: (duration) => real.sleep(duration),
          })
        );
        const pull = yield* Effect.exit(
          engine.pull.pipe(Effect.provideService(Clock.Clock, dieOnceAfterCommit))
        );

        expect(died.count).toBe(1);
        expect(Exit.isFailure(pull)).toBe(true);
        const row = yield* store.getRow("counters", RowId.make("c"));
        expect(row).toMatchObject({ value: { id: "c", n: 2 } });
        expect(yield* tailOf(store)).toEqual([]);
        expect(yield* counterValue(engine)).toBe(2);
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

const incrementCounter = <E>(
  writer: {
    readonly get: (collection: string, id: RowId) => Effect.Effect<unknown, E>;
    readonly put: (collection: string, id: RowId, value: unknown) => Effect.Effect<void, E>;
  },
  id: string
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const current = optionalCountOf(yield* writer.get("counters", RowId.make(id)));
    yield* writer.put("counters", RowId.make(id), { id, n: (current ?? 0) + 1 });
  });

const counterMutators = Mutator.registry([
  {
    mutator: Mutator.make("counter/inc", Schema.Unknown),
    local: (args: { readonly id: string }, writer) => incrementCounter(writer, args.id),
  },
]);

const backendHandlers = {
  "counter/inc": (args, writer) => incrementCounter(writer, idOf(args)),
} satisfies Record<string, MemoryBackend.BackendHandler>;

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

const makeCounterEngine = (
  handler: Parameters<typeof makeInMemory>[0],
  store: ClientStore,
  who: { readonly clientId: string; readonly group: string } = {
    clientId: "client-a",
    group: "group-a",
  }
) =>
  Effect.gen(function* () {
    const transport = yield* makeInMemory(handler, ClientGroupId.make(who.group));
    return yield* ClientEngineModule.make({
      clientId: who.clientId,
      clientGroupId: ClientGroupId.make(who.group),
      mutators: counterMutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const counterValue = (engine: ClientEngineModule.ClientEngine) =>
  engine
    .query(countersSubset)
    .pipe(Effect.map((rows) => optionalCountOf(rows.find((row) => row.id === "c")?.value)));

const tailOf = (store: ClientStore) =>
  store.unpulled.pipe(Effect.map((entries) => entries.map((m) => `${m.clientId}#${m.mutationId}`)));
