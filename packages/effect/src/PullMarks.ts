/**
 * PullMarks
 *
 * Whether a registration's windows have their rows in the replica yet
 * (ADR-0029 section 3, #426). Marks are kept **per window**: each subset an
 * engine is asked to hold gets its own mark, taken when it is first held.
 * A window is **pulled** once a pull numbered above the engine's count at
 * that moment has applied: a pull already in flight may predate it, so it
 * never counts. A window is also pulled when some other pulled window
 * covers it under {@link Coverage.covers}, since then its rows are in the
 * replica already. Adding a window to a relational registration therefore
 * leaves the windows it already had as they were.
 *
 * A registration (its ledger key: the subset hash, or the relational key of
 * {@link MirrorProtocol.relatedKey}) reports a {@link Coverage.Pulled}
 * summary: each window it holds, root included, with its mark. A read is
 * covered only when the windows its rows link to are pulled
 * (`Coverage.pulledFor`); an edge window the registration does not hold is
 * not pulled, so a root that is pulled alone never covers a relational read.
 *
 * Marks are recomputed on every construction, never persisted: after a
 * restart nothing is pulled and a covered read is forwarded until a pull
 * lands.
 */

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Coverage from "./Coverage.js";
import type { ClientEngine } from "./ClientEngine.js";
import * as Subset from "./Subset.js";

/** One held window: how many holds it has, and the engine's pull count when it was first held. */
interface Window {
  readonly subset: Subset.Subset;
  readonly holds: number;
  /**
   * The engine's `started` count when the window was first held; absent until then.
   * A window held by several registrations keeps the mark of its first hold: it is
   * one engine window, so one pull marks it for all of them (N1, #426).
   */
  readonly since: number | undefined;
}

/** One registration: its root window, its holds, and how many holds it has on each window. */
interface Owner {
  readonly root: Subset.Subset;
  readonly holds: number;
  readonly members: ReadonlyMap<string, number>;
}

interface State {
  readonly windows: ReadonlyMap<string, Window>;
  readonly owners: ReadonlyMap<string, Owner>;
}

/** The marks of one engine's registrations. */
export interface PullMarks {
  /**
   * Open a registration under `key`, whose root window is `root`. Opens
   * nest; the registration's marks go with the last {@link close}.
   */
  readonly open: (key: string, root: Subset.Subset) => Effect.Effect<void>;
  /** Close one open of `key`. */
  readonly close: (key: string) => Effect.Effect<void>;
  /**
   * An engine whose `subscribe` and `unsubscribe` hold and release windows
   * under `key`: a window is marked when it is first held, and unmarked
   * when the last hold of it goes.
   */
  readonly wrap: (key: string) => ClientEngine;
  /** The pulled summary of the registration under `key`. */
  readonly pulled: (key: string) => Effect.Effect<Coverage.Pulled>;
  /** The pulled summary of every open registration, by key. */
  readonly registrations: Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly pulled: Coverage.Pulled }>
  >;
}

const summarize = (state: State, key: string, applied: number): Coverage.Pulled => {
  const owner = state.owners.get(key);
  if (owner === undefined) return Coverage.NOT_PULLED;
  const ownPulled = (window: Window): boolean =>
    window.since !== undefined && applied > window.since;
  const pulledSubsets = [...state.windows.values()]
    .filter(ownPulled)
    .map((window) => window.subset);
  const pulled = (window: Window): boolean =>
    ownPulled(window) || pulledSubsets.some((subset) => Coverage.covers(subset, window.subset));
  // Every window the registration holds, root included, with its own mark: a read
  // is judged only by the windows its rows link to (`Coverage.pulledFor`).
  const windows = [...owner.members.keys()].toSorted().flatMap((member) => {
    const window = state.windows.get(member);
    return window === undefined ? [] : [{ subset: window.subset, pulled: pulled(window) }];
  });
  return { windows };
};

const withOwner = (
  map: ReadonlyMap<string, Owner>,
  key: string,
  owner: Owner
): Map<string, Owner> => new Map(map).set(key, owner);

/** Marks over `engine`, which must be the engine the registrations are made on. */
export const make = (engine: ClientEngine): PullMarks => {
  const state = Ref.makeUnsafe<State>({ windows: new Map(), owners: new Map() });

  const ownerOf = (current: State, key: string, root: Subset.Subset): Owner =>
    current.owners.get(key) ?? { root, holds: 0, members: new Map() };

  const subscribe = (key: string, subset: Subset.Subset): Effect.Effect<void> =>
    engine.subscribe(subset).pipe(
      Effect.andThen(engine.pullCounts),
      Effect.flatMap(({ started }) =>
        Ref.update(state, (current) => {
          const hash = Subset.hash(subset);
          const owner = ownerOf(current, key, subset);
          const window = current.windows.get(hash);
          const next = new Map(current.windows).set(hash, {
            subset,
            holds: (window?.holds ?? 0) + 1,
            since: window === undefined ? started : window.since,
          });
          const members = new Map(owner.members).set(hash, (owner.members.get(hash) ?? 0) + 1);
          return {
            windows: next,
            owners: withOwner(current.owners, key, { ...owner, members }),
          };
        })
      )
    );

  const unsubscribe = (key: string, subset: Subset.Subset): Effect.Effect<void> =>
    engine.unsubscribe(subset).pipe(
      Effect.andThen(
        Ref.update(state, (current) => {
          const hash = Subset.hash(subset);
          const owner = current.owners.get(key);
          if (owner === undefined || !owner.members.has(hash)) return current;
          const memberHolds = (owner.members.get(hash) ?? 0) - 1;
          const members = new Map(owner.members);
          if (memberHolds <= 0) members.delete(hash);
          else members.set(hash, memberHolds);
          const window = current.windows.get(hash);
          const windows = new Map(current.windows);
          if (window !== undefined && window.holds > 1) {
            windows.set(hash, { ...window, holds: window.holds - 1 });
          } else {
            windows.delete(hash);
          }
          return { windows, owners: withOwner(current.owners, key, { ...owner, members }) };
        })
      )
    );

  return {
    open: (key, root) =>
      Ref.update(state, (current) => {
        const owner = ownerOf(current, key, root);
        return {
          ...current,
          owners: withOwner(current.owners, key, { ...owner, holds: owner.holds + 1 }),
        };
      }),
    close: (key) =>
      Ref.update(state, (current) => {
        const owner = current.owners.get(key);
        if (owner === undefined) return current;
        const owners = new Map(current.owners);
        if (owner.holds <= 1) owners.delete(key);
        else owners.set(key, { ...owner, holds: owner.holds - 1 });
        return { ...current, owners };
      }),
    wrap: (key) => ({
      ...engine,
      subscribe: (subset) => subscribe(key, subset),
      unsubscribe: (subset) => unsubscribe(key, subset),
    }),
    pulled: (key) =>
      Effect.all({ current: Ref.get(state), counts: engine.pullCounts }).pipe(
        Effect.map(({ current, counts }) => summarize(current, key, counts.applied))
      ),
    registrations: Effect.all({ current: Ref.get(state), counts: engine.pullCounts }).pipe(
      Effect.map(({ current, counts }) =>
        [...current.owners.keys()].toSorted().map((key) => ({
          key,
          pulled: summarize(current, key, counts.applied),
        }))
      )
    ),
  };
};
