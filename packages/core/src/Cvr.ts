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

import { Context, Effect, Layer, Ref } from "effect";
import type { RowId, RowVersion } from "./Collection.js";
import type { StoreError } from "./Errors.js";

/** What one client group holds: collection → row id → row version. */
export interface Cvr {
  readonly rows: ReadonlyMap<string, ReadonlyMap<RowId, RowVersion>>;
}

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

  for (const [collection, nextRows] of next.rows) {
    const prevRows = previous.rows.get(collection);
    for (const [id, version] of nextRows) {
      if (prevRows?.get(id) !== version) puts.push({ collection, id });
    }
  }
  for (const [collection, prevRows] of previous.rows) {
    const nextRows = next.rows.get(collection);
    for (const id of prevRows.keys()) {
      if (!nextRows?.has(id)) dels.push({ collection, id });
    }
  }
  return { puts, dels };
};

/** CVR persistence, keyed by cookie. */
export interface CvrStore {
  readonly get: (cookie: string) => Effect.Effect<Cvr | undefined, StoreError>;
  readonly set: (cookie: string, cvr: Cvr) => Effect.Effect<void, StoreError>;
  /** Forget CVRs for cookies no longer presentable (optional hygiene). */
  readonly remove: (cookie: string) => Effect.Effect<void, StoreError>;
}

export const CvrStore = Context.Service<CvrStore>("@thomasfosterau/effect-sync-core/CvrStore");

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

export const layerMemoryStore: Layer.Layer<CvrStore> = Layer.effect(CvrStore)(makeMemoryStore);
