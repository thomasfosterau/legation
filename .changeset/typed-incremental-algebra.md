---
"@thomasfosterau/legation": minor
---

The incremental operator algebra on `./internal` is typed by its row (#562). **Breaking for adapter authors**, at the type level and in one runtime shape.

- **`Incremental`**: `Row<A>`, `Delta<A>`, `Operator<A, B>`, `Group<A>`, `OrderedWindow<A>` and `JoinOperator<L, R, C>` carry their value types. `makeFilter<A>` returns `Operator<A, A>`, `makeMap<A, B>(f: (value: A) => B)` returns `Operator<A, B>`, `makeGroupBy<A>` returns `Operator<A, Group<A>>`, and the `*FromScratch` references follow. `JoinOptions<L, R, K, C>` types `leftKey: (value: L) => K` and `rightKey: (value: R) => K` with one shared key type `K` (so the two sides' keys are checked against each other) and `combine?: JoinCombine<L, R, C>`. `makeJoin` and `joinFromScratch` are overloaded: with a `combine` (`CombinedJoinOptions`) the joined value is its `C`; without one it is the new `Joined<L, R>` (`{ left, right }`).
- **`Derive`**: `Source<A, E>` (was `Source<E>`), `Row<A>` and `DerivedResult<A, E>` take the row type. `map<A, B, E>(source: Source<A, E>, f: (value: A) => B): Source<B, E>` (and `select`), `filter`, `distinct` and `orderedWindow` keep `A`, `groupBy` yields `Source<Group<A>, E>`, and `join` yields `Source<C, E | F>` or `Source<Joined<L, R>, E | F>` as above. `observed` yields `Source<unknown, ClientViewError>`: its rows are the store's untyped `LocalRow`s.
- **`LiveView`**: `LiveView<A>`, `PositionedRow<A>` and the new `ValueRow<A>` carry the row value type, through `make`, `makeIndexed`, `put`, `del`, `result` and `retarget`. Both default to `unknown`, so existing `LiveView.LiveView` annotations are unchanged.
- **Runtime change: a left join's unmatched right is now an `Option`.** `combine` receives `right: Option.Option<R>` (was `R | null`), and the default joined value's `right` is `Option.Option<R>` (`Option.none()` when unmatched, was `null`).

Migrating: replace `Derive.Source<E>` with `Derive.Source<A, E>` (`Source<unknown, E>` for untyped rows), `Incremental.Row`/`Delta`/`Operator` with their parameterised forms, and drop the `as` casts in projections, predicates and key functions, which now receive the source's row type. In a left join, read the right side as an `Option` (`Option.match(right, { onNone, onSome })`, `Option.map`, `Option.getOrNull`) instead of testing it for `null`.
