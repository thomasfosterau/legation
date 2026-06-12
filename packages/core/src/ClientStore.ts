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

import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import type { RowId, RowVersion } from "./Collection.js";
import { StoreError } from "./Errors.js";
import type { Mutation } from "./Protocol.js";

/** A confirmed row as persisted: encoded value + authoritative version. */
export interface StoredRow {
  readonly id: RowId;
  readonly version: RowVersion;
  readonly value: unknown;
}

export interface ClientStore {
  // Confirmed rows
  readonly getRow: (
    collection: string,
    id: RowId
  ) => Effect.Effect<StoredRow | undefined, StoreError>;
  readonly listRows: (collection: string) => Effect.Effect<ReadonlyArray<StoredRow>, StoreError>;
  readonly putRow: (collection: string, row: StoredRow) => Effect.Effect<void, StoreError>;
  readonly delRow: (collection: string, id: RowId) => Effect.Effect<void, StoreError>;
  readonly clearRows: Effect.Effect<void, StoreError>;

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

export const ClientStore = Context.Service<ClientStore>(
  "@thomasfosterau/effect-sync-core/ClientStore"
);

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
  /** Key namespace inside the KeyValueStore. Defaults to `"effect-sync/"`. */
  readonly prefix?: string;
}

/**
 * The durable implementation (ADR-0007): ClientStore over
 * `effect/unstable/persistence` KeyValueStore, so any platform KVS —
 * browser IndexedDB/localStorage, Node file system, SQL — persists the
 * engine. Layout: one JSON blob per collection (`rows/{collection}`), plus
 * `collections`, `journal`, `counters`, and `cookie` keys.
 *
 * Read-modify-write operations are serialized through a semaphore, which
 * makes one store instance safe for concurrent fibers — not for concurrent
 * processes (the service-worker host is the per-origin singleton,
 * ADR-0010).
 */
const rowsKey = (collection: string) => `rows/${collection}`;

export const makeKeyValue = (
  options?: KeyValueOptions
): Effect.Effect<ClientStore, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = KeyValueStore.prefix(
      yield* KeyValueStore.KeyValueStore,
      options?.prefix ?? "effect-sync/"
    );
    const lock = yield* Semaphore.make(1);
    const locked = <A, E>(effect: Effect.Effect<A, E>) => Semaphore.withPermit(lock, effect);

    const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });

    const readJson = <A>(key: string): Effect.Effect<A | undefined, StoreError> =>
      store.get(key).pipe(
        Effect.mapError(storeError(`Failed to read "${key}"`)),
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed(undefined)
            : Effect.try({
                try: () => JSON.parse(raw) as A,
                catch: storeError(`Corrupt JSON at "${key}"`),
              })
        )
      );
    const writeJson = (key: string, value: unknown): Effect.Effect<void, StoreError> =>
      store
        .set(key, JSON.stringify(value))
        .pipe(Effect.mapError(storeError(`Failed to write "${key}"`)));

    const rowMap = (collection: string) =>
      readJson<Record<RowId, StoredRow>>(rowsKey(collection)).pipe(Effect.map((map) => map ?? {}));
    const collections = readJson<ReadonlyArray<string>>("collections").pipe(
      Effect.map((list) => list ?? [])
    );
    const trackCollection = (collection: string) =>
      collections.pipe(
        Effect.flatMap((list) =>
          list.includes(collection) ? Effect.void : writeJson("collections", [...list, collection])
        )
      );
    const journal = readJson<ReadonlyArray<Mutation>>("journal").pipe(
      Effect.map((entries) => entries ?? [])
    );

    return ClientStore.of({
      getRow: (collection, id) => rowMap(collection).pipe(Effect.map((map) => map[id])),
      listRows: (collection) => rowMap(collection).pipe(Effect.map((map) => Object.values(map))),
      putRow: (collection, row) =>
        locked(
          Effect.gen(function* () {
            const map = yield* rowMap(collection);
            yield* writeJson(rowsKey(collection), { ...map, [row.id]: row });
            yield* trackCollection(collection);
          })
        ),
      delRow: (collection, id) =>
        locked(
          Effect.gen(function* () {
            const { [id]: _removed, ...rest } = yield* rowMap(collection);
            yield* writeJson(rowsKey(collection), rest);
          })
        ),
      clearRows: locked(
        Effect.gen(function* () {
          for (const collection of yield* collections) {
            yield* store
              .remove(rowsKey(collection))
              .pipe(Effect.mapError(storeError(`Failed to clear "${collection}"`)));
          }
          yield* writeJson("collections", []);
        })
      ),

      appendMutation: (mutation) =>
        locked(
          journal.pipe(Effect.flatMap((entries) => writeJson("journal", [...entries, mutation])))
        ),
      pendingMutations: journal,
      acknowledge: (clientId, upTo) =>
        locked(
          journal.pipe(
            Effect.flatMap((entries) =>
              writeJson(
                "journal",
                entries.filter((m) => m.clientId !== clientId || m.mutationId > upTo)
              )
            )
          )
        ),
      nextMutationId: (clientId) =>
        locked(
          Effect.gen(function* () {
            const counters = (yield* readJson<Record<string, number>>("counters")) ?? {};
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
