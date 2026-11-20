/**
 * PullMarks
 *
 * Whether a registration's windows have their rows in the replica yet
 * (ADR-0029 section 3). Marks are kept **per window**: each subset an
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

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Coverage from "./Coverage.js";
import type { ClientEngine } from "./ClientEngine.js";
import * as Subset from "./Subset.js";

/** One held window: how many holds it has, and the engine's pull count when it was first held. */
interface Window {
  readonly subset: Subset.Subset;
  readonly holds: number;
  /**
   * The engine's `started` count when the window was first held.
   * A window held by several registrations keeps the mark of its first hold: it is
   * one engine window, so one pull marks it for all of them (N1).
   */
  readonly since: number;
}

/** One registration: its root window, its holds, and how many holds it has on each window. */
interface Owner {
  readonly root: Subset.Subset;
  readonly holds: number;
  readonly members: HashMap.HashMap<string, number>;
}

interface State {
  readonly windows: HashMap.HashMap<string, Window>;
  readonly owners: HashMap.HashMap<string, Owner>;
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
  const found = HashMap.get(state.owners, key);
  if (Option.isNone(found)) return Coverage.NOT_PULLED;
  const owner = found.value;
  const ownPulled = (window: Window): boolean => applied > window.since;
  const pulledSubsets = Arr.fromIterable(HashMap.values(state.windows))
    .filter(ownPulled)
    .map((window) => window.subset);
  const pulled = (window: Window): boolean =>
    ownPulled(window) || pulledSubsets.some((subset) => Coverage.covers(subset, window.subset));
  // Every window the registration holds, root included, with its own mark: a read
  // is judged only by the windows its rows link to (`Coverage.pulledFor`).
  const windows = Arr.sort(HashMap.keys(owner.members), Order.String).flatMap((member) =>
    Arr.fromOption(
      Option.map(HashMap.get(state.windows, member), (window) => ({
        subset: window.subset,
        pulled: pulled(window),
      }))
    )
  );
  return { windows };
};

const withOwner = (
  map: HashMap.HashMap<string, Owner>,
  key: string,
  owner: Owner
): HashMap.HashMap<string, Owner> => HashMap.set(map, key, owner);

/** Marks over `engine`, which must be the engine the registrations are made on. */
export const make = (engine: ClientEngine): PullMarks => {
  const state = Ref.makeUnsafe<State>({ windows: HashMap.empty(), owners: HashMap.empty() });

  const ownerOf = (current: State, key: string, root: Subset.Subset): Owner =>
    Option.getOrElse(HashMap.get(current.owners, key), () => ({
      root,
      holds: 0,
      members: HashMap.empty<string, number>(),
    }));

  const subscribe = (key: string, subset: Subset.Subset): Effect.Effect<void> =>
    engine.subscribe(subset).pipe(
      Effect.andThen(engine.pullCounts),
      Effect.flatMap(({ started }) =>
        Ref.update(state, (current) => {
          const hash = Subset.hash(subset);
          const owner = ownerOf(current, key, subset);
          const window = HashMap.get(current.windows, hash);
          const next = HashMap.set(current.windows, hash, {
            subset,
            holds: Option.match(window, { onNone: () => 0, onSome: (w) => w.holds }) + 1,
            since: Option.match(window, { onNone: () => started, onSome: (w) => w.since }),
          });
          const members = HashMap.set(
            owner.members,
            hash,
            Option.getOrElse(HashMap.get(owner.members, hash), () => 0) + 1
          );
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
          const found = HashMap.get(current.owners, key);
          if (Option.isNone(found) || !HashMap.has(found.value.members, hash)) return current;
          const owner = found.value;
          const memberHolds = Option.getOrElse(HashMap.get(owner.members, hash), () => 0) - 1;
          const members =
            memberHolds <= 0
              ? HashMap.remove(owner.members, hash)
              : HashMap.set(owner.members, hash, memberHolds);
          const window = HashMap.get(current.windows, hash);
          const windows =
            Option.isSome(window) && window.value.holds > 1
              ? HashMap.set(current.windows, hash, {
                  ...window.value,
                  holds: window.value.holds - 1,
                })
              : HashMap.remove(current.windows, hash);
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
        const found = HashMap.get(current.owners, key);
        if (Option.isNone(found)) return current;
        const owner = found.value;
        const owners =
          owner.holds <= 1
            ? HashMap.remove(current.owners, key)
            : HashMap.set(current.owners, key, { ...owner, holds: owner.holds - 1 });
        return { ...current, owners };
      }),
    wrap: (key) => ({
      ...engine,
      subscribe: (subset) => subscribe(key, subset),
      unsubscribe: (subset) => unsubscribe(key, subset),
    }),
    pulled: (key) =>
      Effect.all({ current: Ref.get(state), counts: engine.pullCounts }, { concurrency: 1 }).pipe(
        Effect.map(({ current, counts }) => summarize(current, key, counts.applied))
      ),
    registrations: Effect.all(
      { current: Ref.get(state), counts: engine.pullCounts },
      { concurrency: 1 }
    ).pipe(
      Effect.map(({ current, counts }) =>
        Arr.sort(HashMap.keys(current.owners), Order.String).map((key) => ({
          key,
          pulled: summarize(current, key, counts.applied),
        }))
      )
    ),
  };
};
