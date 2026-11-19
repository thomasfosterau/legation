/**
 * Derive
 *
 * Client-local **derived live queries**: a set of bare, composable combinators
 * — `filter`, `map`/`select`, `join`, `groupBy`, `distinct`, `orderedWindow` —
 * over already-observed sources, each incrementally maintained from row deltas
 * by the pure {@link Incremental} engines. This is the expressiveness tier the
 * #114 brief describes: the relational shaping (arbitrary joins, DISTINCT,
 * row-level group-by, computed/cross-field predicates) that the serializable
 * `Subset`/`Predicate` wire language deliberately does not carry, done here in
 * memory over what the client has already synced.
 *
 * **The boundary rule — derived combinators never widen what syncs
 * (ADR-0027).** A combinator sees only the rows its source streams already
 * hold; the serializable Query/Subset tier underneath alone decides what the
 * server ships. The failure mode this forbids: filtering locally and believing
 * the result set is complete. Deriving `filter((t) => t.urgent)` over a page
 * synced as "my open todos" shows the urgent ones *among the todos already
 * synced* — never any the sync window excluded. If a derived view needs rows
 * the client does not hold, widen the `Query` (what syncs), not the combinator
 * (what is shown).
 *
 * **The seam.** A source is anything satisfying the `ClientView.observe`
 * shape — a `subset -> Stream<page>` observation of an owned engine or a
 * mirror, *or the output of another combinator* (every combinator's output is
 * a page stream of the same `(id, value)` rows, so queries-from-queries falls
 * straight out of the shared shape, the same trick `LiveQuery` and `Related`
 * already play). A combinator recovers deltas by diffing consecutive `observe`
 * pages ({@link Incremental.diff}) — the page-diffing path ADR-0027 §4
 * describes, and the fallback for a plain page source (a raw `Stream`, or
 * another combinator's output).
 *
 * **`observed` prefers `observeChanges` (#115).** When the leaf is built from
 * a full `ClientView` (rather than the narrower `Reader`), `observed` reads
 * its `observeChanges` enter/update/exit/move feed directly instead of
 * `observe`'s pages: `LiveView` already decided each row's delta, so
 * `Incremental.deltaFromChanges` just reads that decision instead of
 * `Incremental.diff` recomputing it from two page `Map`s. The resulting
 * `Source` is tagged (invisibly to its `Stream.Stream<ReadonlyArray<Row>, E>`
 * type) with its native change feed, so every combinator built on top of it —
 * `filter`, `map`, `join`, `groupBy`, `distinct`, `orderedWindow` — consumes
 * that feed too, one level deep. A source built any other way (a raw
 * `Stream`, `view.observe(subset)` called directly, or a combinator's own
 * output) carries no such tag and falls back to page-diffing, unchanged.
 *
 * **Observability.** A derived pipeline is an Effect `Stream` and, via
 * {@link atom}, an Atom on the standard `effect/reactivity` surface —
 * so framework bindings need nothing new: `@thomasfosterau/legation-svelte`'s `query` store
 * and `@thomasfosterau/legation-svelte`'s `useQuery` bind a derived stream exactly as they bind
 * a raw `observe`.
 *
 * **Lifetime.** {@link observed} pairs a refcounted `Subscriptions` acquire
 * with the source observation and releases it when its scope closes, so a
 * pipeline built from `observed` leaves tears the whole chain's subscriptions
 * down together — the same discipline as `Related`.
 */

import type * as Cause from "effect/Cause";
import type * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, type AsyncResult } from "effect/reactivity";
import type * as ClientView from "./ClientView.js";
import * as Hash from "./Hash.js";
import * as Incremental from "./Incremental.js";
import type { RowChange } from "./RowChange.js";
import type * as Subscriptions from "./Subscriptions.js";
import type * as Subset from "./Subset.js";

/**
 * A derived row: the `(id, value)` unit with an `A` value, structurally
 * `ClientEngine.LocalRow` at `A = unknown` and `ClientEngine.TypedRow<A>` otherwise.
 */
export type Row<A> = Incremental.Row<A>;

/**
 * A derived source: a stream of page snapshots of `A` rows (what
 * `ClientView.observe` yields, at `A = unknown`; a typed `observe` over a
 * `Subset.TypedSubset<A>` yields a `Source<A, E>`).
 */
export type Source<A, E> = Stream.Stream<ReadonlyArray<Row<A>>, E>;

/** A join's value without a `combine` (re-exported from {@link Incremental}). */
export type Joined<L, R> = Incremental.Joined<L, R>;

// ─── The observeChanges tag (see the module doc's "observed prefers
// observeChanges" section) ────────────────────────────────────────────────
//
// `Source<A, E>` must stay exactly `Stream.Stream<ReadonlyArray<Row<A>>, E>` — it is
// handed around and constructed directly (a raw `Stream.fromIterable`, or
// `view.observe(subset)`) by callers who never go through `observed`. A tag
// smuggled onto the *value* `observed` returns (an ordinary, extensible
// object, like every Effect `Stream`) lets a combinator opportunistically
// recover the native change feed without widening that public type: present,
// it's used; absent (a raw stream, or another combinator's own page output),
// the page-diff fallback below runs exactly as before.
const CHANGES = Symbol.for("@thomasfosterau/legation/Derive/changes");

interface ChangeTagged<A, E> {
  readonly [CHANGES]: Stream.Stream<ReadonlyArray<RowChange<Row<A>>>, E>;
}

const withChanges = <A, E>(
  pages: Source<A, E>,
  changes: Stream.Stream<ReadonlyArray<RowChange<Row<A>>>, E>
): Source<A, E> => Object.assign(pages, { [CHANGES]: changes } satisfies ChangeTagged<A, E>);

const isChangeTagged = <A, E>(source: Source<A, E>): source is Source<A, E> & ChangeTagged<A, E> =>
  CHANGES in source;

const changesOf = <A, E>(
  source: Source<A, E>
): Stream.Stream<ReadonlyArray<RowChange<Row<A>>>, E> | undefined =>
  isChangeTagged(source) ? source[CHANGES] : undefined;

// ─── Dedup ───────────────────────────────────────────────────────────────────

const sameRow = <A>(a: Row<A>, b: Row<A>): boolean =>
  a === b || (a.id === b.id && Hash.contentHash(a.value) === Hash.contentHash(b.value));

/**
 * Two derived pages are equal when they have the same rows in the same order.
 * Set combinators emit in a stable id order (see {@link Incremental.pageOf}) and
 * `orderedWindow` in its comparator order, so a positional compare never sees a
 * spurious reorder — a genuine no-op step re-emits nothing.
 */
const samePage = <A>(a: ReadonlyArray<Row<A>>, b: ReadonlyArray<Row<A>>): boolean =>
  a.length === b.length &&
  a.every((row, i) => {
    const other = b[i];
    return other !== undefined && sameRow(row, other);
  });

// ─── Single-input maintenance ────────────────────────────────────────────────

/**
 * Recover a delta per emission from any `Source`: when it carries the
 * {@link CHANGES} tag (built by `observed` over a `ClientView`), read the
 * delta `LiveView` already computed (`Incremental.deltaFromChanges`);
 * otherwise diff each page against the last snapshot
 * ({@link Incremental.diff}), the pre-#115 fallback for a plain page source.
 * Every combinator funnels through this so the tag needs checking once, not
 * once per combinator.
 */
const toDeltaStream = <A, E>(source: Source<A, E>): Stream.Stream<Incremental.Delta<A>, E> => {
  const changes = changesOf(source);
  return changes !== undefined
    ? changes.pipe(
        Stream.mapAccum(
          () => new Map<string, Row<A>>(),
          (known, batch) => [known, [Incremental.deltaFromChanges(known, batch)]] as const
        )
      )
    : source.pipe(
        Stream.mapAccum(
          () => new Map<string, Row<A>>(),
          (last, page) => {
            const { delta, index } = Incremental.diff(last, page);
            return [index, [delta]] as const;
          }
        )
      );
};

/**
 * Drive one delta→delta {@link Incremental.Operator} over a source's deltas
 * ({@link toDeltaStream}): step the operator, fold the output delta into a
 * maintained result, and emit the result as a page (deduped). The operator
 * (and its state) is built lazily per subscription, so one derived value
 * mounted from many components each gets its own maintained state.
 */
const maintain = <A, B, E>(
  source: Source<A, E>,
  makeOperator: () => Incremental.Operator<A, B>
): Source<B, E> =>
  toDeltaStream(source).pipe(
    Stream.mapAccum(
      () => ({ operator: makeOperator(), result: new Map<string, Row<B>>() }),
      (state, delta) => {
        Incremental.applyDelta(state.result, state.operator.step(delta));
        return [state, [Incremental.pageOf(state.result)]] as const;
      }
    ),
    Stream.changesWith(samePage)
  );

/**
 * Keep the rows whose value passes an arbitrary JS predicate. The predicate is
 * never serialized and never narrows what syncs — it shapes only what is shown
 * of the already-synced page (the boundary rule above).
 */
export const filter = <A, E>(
  source: Source<A, E>,
  predicate: (value: A) => boolean
): Source<A, E> => maintain(source, () => Incremental.makeFilter(predicate));

/** Project each row's `A` value through an arbitrary JS function to a `B`, keeping its id. */
export const map = <A, B, E>(source: Source<A, E>, f: (value: A) => B): Source<B, E> =>
  maintain(source, () => Incremental.makeMap(f));

/** {@inheritDoc map} — `select` reads better for a projection; same combinator. */
export const select = map;

/** Collapse duplicate values to one row, keyed by the canonical value. */
export const distinct = <A, E>(source: Source<A, E>): Source<A, E> =>
  maintain(source, () => Incremental.makeDistinct<A>());

/**
 * Group rows by an arbitrary key function, emitting one row per group whose
 * value is `{ key, rows }` (the group's member values). A having-clause is
 * `filter` after `groupBy`; a scalar rollup is `map` over the group rows.
 */
export const groupBy = <A, E>(
  source: Source<A, E>,
  key: (value: A) => string
): Source<Incremental.Group<A>, E> => maintain(source, () => Incremental.makeGroupBy(key));

// ─── Join (two inputs) ───────────────────────────────────────────────────────

/** Options for {@link join} (re-exported from {@link Incremental}). */
export type JoinOptions<L, R, K, C> = Incremental.JoinOptions<L, R, K, C>;

/** {@link JoinOptions} with its `combine` given (re-exported from {@link Incremental}). */
export type CombinedJoinOptions<L, R, K, C> = Incremental.CombinedJoinOptions<L, R, K, C>;

/**
 * Join two derived sources on arbitrary key equality (inner or left). Merges
 * the two page streams, feeding each side's delta to the shared join operator,
 * which re-derives only the left rows a change touches. A joined row's value is
 * a {@link Joined} `{ left, right }` by default (`right` is an `Option`:
 * `Option.none()` for an unmatched left row under `kind: "left"`); pass
 * `combine` to shape it
 * otherwise. Both key extractors return one key type, so the two sides' keys
 * are checked against each other.
 */
export function join<L, R, K, C, E, F>(
  left: Source<L, E>,
  right: Source<R, F>,
  options: CombinedJoinOptions<L, R, K, C>
): Source<C, E | F>;
export function join<L, R, K, E, F>(
  left: Source<L, E>,
  right: Source<R, F>,
  options: JoinOptions<L, R, K, Joined<L, R>>
): Source<Joined<L, R>, E | F>;
export function join<L, R, K, C, E, F>(
  left: Source<L, E>,
  right: Source<R, F>,
  options: JoinOptions<L, R, K, C>
): Source<C | Joined<L, R>, E | F>;
export function join<L, R, K, C, E, F>(
  left: Source<L, E>,
  right: Source<R, F>,
  options: JoinOptions<L, R, K, C>
): Source<C | Joined<L, R>, E | F> {
  const tagged: Stream.Stream<
    | { readonly side: "left"; readonly delta: Incremental.Delta<L> }
    | { readonly side: "right"; readonly delta: Incremental.Delta<R> },
    E | F
  > = Stream.merge(
    toDeltaStream(left).pipe(Stream.map((delta) => ({ side: "left" as const, delta }))),
    toDeltaStream(right).pipe(Stream.map((delta) => ({ side: "right" as const, delta })))
  );
  return tagged.pipe(
    Stream.mapAccum(
      () => ({
        operator: Incremental.makeJoin(options),
        result: new Map<string, Row<C | Joined<L, R>>>(),
      }),
      (state, event) => {
        const outDelta =
          event.side === "left"
            ? state.operator.stepLeft(event.delta)
            : state.operator.stepRight(event.delta);
        Incremental.applyDelta(state.result, outDelta);
        return [state, [Incremental.pageOf(state.result)]] as const;
      }
    ),
    Stream.changesWith(samePage)
  );
}

// ─── Ordered window ──────────────────────────────────────────────────────────

/** Options for {@link orderedWindow}: a sort order and an optional row limit. */
export interface OrderedWindowOptions {
  readonly orderBy: ReadonlyArray<Subset.OrderBy>;
  readonly limit?: number;
}

/**
 * Sort derived rows by an `orderBy` and keep the first `limit` — an ORDER
 * BY … LIMIT over the derived result, maintained by `LiveView`'s `OrderedTree`
 * so a change outside the window costs the same as one inside it (ADR-0026's
 * one ordering authority applies, so "no orderBy" still means stable id order).
 */
export const orderedWindow = <A, E>(
  source: Source<A, E>,
  options: OrderedWindowOptions
): Source<A, E> =>
  toDeltaStream(source).pipe(
    Stream.mapAccum(
      () => Incremental.makeOrderedWindow<A>(options.orderBy, options.limit),
      (window, delta) => [window, [window.step(delta)]] as const
    ),
    Stream.changesWith(samePage)
  );

// ─── Observability ───────────────────────────────────────────────────────────

/** A derived value's Atom: the current page of `A` rows as an `AsyncResult`, re-emitting on change. */
export type DerivedResult<A, E> = AsyncResult.AsyncResult<
  ReadonlyArray<Row<A>>,
  E | Cause.NoSuchElementError
>;

/**
 * Expose a derived pipeline as an Atom on the standard reactivity surface — the
 * same shape `LiveQuery.make(...).atom(...)` produces for a raw subset, so a
 * framework binding renders a derived value with no new machinery.
 */
export const atom = <A, E>(source: Source<A, E>): Atom.Atom<DerivedResult<A, E>> =>
  Atom.make(source);

// ─── Lifetime ────────────────────────────────────────────────────────────────

/**
 * Fold an `observeChanges` feed into a page stream without ever diffing a
 * page: each batch's delta ({@link Incremental.deltaFromChanges}) is folded
 * straight into a running result map. This is what `observed` returns when
 * the view has `observeChanges` — a real, standalone page stream (so it's
 * correct if consumed directly), separate from the {@link CHANGES} tag that
 * lets a combinator built on top skip this fold entirely and read the same
 * underlying batches itself.
 */
const pagesFromChanges = <A, E>(
  changes: Stream.Stream<ReadonlyArray<RowChange<Row<A>>>, E>
): Source<A, E> =>
  changes.pipe(
    Stream.mapAccum(
      () => ({ known: new Map<string, Row<A>>(), result: new Map<string, Row<A>>() }),
      (state, batch) => {
        Incremental.applyDelta(state.result, Incremental.deltaFromChanges(state.known, batch));
        return [state, [Incremental.pageOf(state.result)]] as const;
      }
    ),
    Stream.changesWith(samePage)
  );

/**
 * A scoped leaf source: acquire a refcounted subscription for `subset` (so the
 * rows actually sync) and observe it, releasing the subscription when the scope
 * closes. A pipeline built from `observed` leaves holds all its sources'
 * subscriptions for its lifetime and drops them together on teardown — the
 * refcounted-lifetime discipline the #114 brief asks for, `Subscriptions`
 * doing the reference counting so a shared leaf is synced once.
 *
 * When `view` is a full {@link ClientView.ClientView} (not just the narrower
 * {@link ClientView.Reader}), the returned source is built from its
 * `observeChanges` feed and tagged so every combinator composed on top reads
 * that feed directly too (see the module doc). A bare `Reader` has no
 * `observeChanges` to prefer, so this falls back to `observe`'s pages,
 * unchanged.
 *
 * The rows enter untyped (`ClientView`'s `LocalRow`s), so the leaf is a
 * `Source<unknown, …>`; a `map` over it that decodes the value types
 * everything downstream by what it returns.
 */
export const observed = (
  subscriptions: Subscriptions.Subscriptions,
  view: ClientView.Reader | ClientView.ClientView,
  subset: Subset.Subset
): Effect.Effect<Source<unknown, ClientView.ClientViewError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* subscriptions.acquire(subset);
    yield* Effect.addFinalizer(() => handle.release);
    if (!("observeChanges" in view)) return view.observe(subset);
    const changes = view.observeChanges(subset, { includeInitial: true });
    return withChanges(pagesFromChanges(changes), changes);
  });
