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

import { Context, Effect, Layer, Ref } from "effect";
import type { RowId, RowVersion } from "./Collection.js";
import type { StoreError } from "./Errors.js";
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
