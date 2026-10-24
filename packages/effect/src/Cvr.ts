/**
 * Cvr — Client View Record
 *
 * The server-side record of exactly which row versions a client group
 * holds (ADR-0008). Each pull: evaluate the client's authorized subsets to
 * the current (id, version) sets, diff against the CVR identified by the
 * presented cookie, send the difference as a patch, store the new CVR under
 * a fresh cookie.
 *
 * CVR storage may be ephemeral: an unrecognized cookie degrades safely to a
 * reset patch (Clear + full Puts).
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { KeyValueStore } from "effect/persistence";
import type { RowId, RowVersion } from "./Collection.js";
import { StoreError } from "./Errors.js";

/** What one client group holds: collection → row id → row version. */
export interface Cvr {
  readonly rows: ReadonlyMap<string, ReadonlyMap<RowId, RowVersion>>;
}

/** The CVR of a group that holds nothing yet. */
export const empty: Cvr = { rows: new Map() };

/** The desired next view, computed from evaluated subsets + fetched rows. */
export interface NextView {
  readonly rows: ReadonlyMap<string, ReadonlyMap<RowId, RowVersion>>;
}

/** A diff between a CVR and the next view, in row-id terms. */
export interface CvrDiff {
  /** Rows the client is missing or holds at a stale version. */
  readonly puts: ReadonlyArray<{ readonly collection: string; readonly id: RowId }>;
  /** Rows the client holds that left the view. */
  readonly dels: ReadonlyArray<{ readonly collection: string; readonly id: RowId }>;
}

/** Pure CVR diff: what to put (missing/stale) and what to delete (gone). */
export const diff = (previous: Cvr, next: NextView): CvrDiff => {
  const puts: Array<{ collection: string; id: RowId }> = [];
  const dels: Array<{ collection: string; id: RowId }> = [];

  Arr.forEach(next.rows, ([collection, nextRows]) => {
    const prevRows = previous.rows.get(collection);
    Arr.forEach(nextRows, ([id, version]) => {
      if (prevRows?.get(id) !== version) puts.push({ collection, id });
    });
  });
  Arr.forEach(previous.rows, ([collection, prevRows]) => {
    const nextRows = next.rows.get(collection);
    Arr.forEach(prevRows.keys(), (id) => {
      if (!nextRows?.has(id)) dels.push({ collection, id });
    });
  });
  return { puts, dels };
};

/** CVR persistence, keyed by cookie. */
export interface CvrStore {
  readonly get: (cookie: string) => Effect.Effect<Cvr | undefined, StoreError>;
  readonly set: (cookie: string, cvr: Cvr) => Effect.Effect<void, StoreError>;
  /** Forget CVRs for cookies no longer presentable (optional hygiene). */
  readonly remove: (cookie: string) => Effect.Effect<void, StoreError>;
}

/** The {@link CvrStore} service the sync server keeps CVRs in. */
export const CvrStore = Context.Service<CvrStore>("@thomasfosterau/legation-effect/CvrStore");

/** In-memory CVR store (tests, single-instance servers, sync rooms). */
export const makeMemoryStore: Effect.Effect<CvrStore> = Effect.gen(function* () {
  const state = yield* Ref.make(new Map<string, Cvr>());
  return CvrStore.of({
    get: (cookie) => Ref.get(state).pipe(Effect.map((m) => m.get(cookie))),
    set: (cookie, cvr) =>
      Ref.update(state, (m) => {
        const next = new Map(m);
        next.set(cookie, cvr);
        return next;
      }),
    remove: (cookie) =>
      Ref.update(state, (m) => {
        const next = new Map(m);
        next.delete(cookie);
        return next;
      }),
  });
});

/** A layer providing {@link makeMemoryStore}. */
export const layerMemoryStore: Layer.Layer<CvrStore> = Layer.effect(CvrStore)(makeMemoryStore);

// ─── Shared-storage CVR store (distributed) ──────────────────────────────────

/**
 * The JSON-serializable shape of a CVR on disk: rows as nested entry pairs.
 * The schema is the source of truth for the on-disk form and for decoding
 * untrusted stored bytes; `WireCvr` is derived from it.
 */
const WireCvrSchema = Schema.fromJsonString(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Tuple([
        Schema.String,
        Schema.Array(Schema.Tuple([Schema.String, Schema.Union([Schema.String, Schema.Number])])),
      ])
    ),
  })
);

type WireCvr = typeof WireCvrSchema.Type;

const decodeCvr = Schema.decodeUnknownEffect(WireCvrSchema);

const toWire = (cvr: Cvr): WireCvr => ({
  rows: [...cvr.rows].map(([collection, versions]) => [collection, [...versions]] as const),
});

const fromWire = (wire: WireCvr): Cvr => ({
  rows: new Map(wire.rows.map(([collection, versions]) => [collection, new Map(versions)])),
});

/**
 * Options for a {@link CvrStore} over an Effect `KeyValueStore` (a store shared across instances).
 */
export interface KeyValueCvrOptions {
  /** Key namespace inside the store. Defaults to `"legation/cvr/"`. */
  readonly prefix?: string;
}

/**
 * A CVR store over `effect/persistence` KeyValueStore (ADR-0009):
 * back it with a *shared* KVS — Redis, SQL, a Durable Object's storage — and
 * every server instance reads the same client view records, so a client can
 * present a cookie minted by one instance and pull a minimal patch from
 * another. CVR storage may be ephemeral (an unrecognized cookie degrades to
 * a reset), so eviction/TTL is the backing store's concern.
 */
export const makeKeyValueStore = (
  options?: KeyValueCvrOptions
): Effect.Effect<CvrStore, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = KeyValueStore.prefix(
      yield* KeyValueStore.KeyValueStore,
      options?.prefix ?? "legation/cvr/"
    );
    const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });
    return CvrStore.of({
      get: (cookie) =>
        store.get(cookie).pipe(
          Effect.mapError(storeError(`Failed to read CVR "${cookie}"`)),
          Effect.flatMap((raw) =>
            raw === undefined
              ? Effect.succeed(undefined)
              : decodeCvr(raw).pipe(
                  Effect.map(fromWire),
                  Effect.mapError(storeError(`Corrupt CVR at "${cookie}"`))
                )
          )
        ),
      set: (cookie, cvr) =>
        store
          .set(cookie, JSON.stringify(toWire(cvr)))
          .pipe(Effect.mapError(storeError(`Failed to write CVR "${cookie}"`))),
      remove: (cookie) =>
        store.remove(cookie).pipe(Effect.mapError(storeError(`Failed to remove CVR "${cookie}"`))),
    });
  });

/** Layer providing the KeyValueStore-backed CVR store. */
export const layerKeyValueStore = (
  options?: KeyValueCvrOptions
): Layer.Layer<CvrStore, never, KeyValueStore.KeyValueStore> =>
  Layer.effect(CvrStore)(makeKeyValueStore(options));
