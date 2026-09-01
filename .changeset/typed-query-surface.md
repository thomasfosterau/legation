---
"@legation/effect": minor
"@legation/svelte": minor
---

Add a typed query surface over the existing untyped `Subset`/`LocalRow` (purely
additive — the protocol-level and dynamic surface is unchanged).

- `Subset.for(collection).make({ where, orderBy, limit, cursor })` builds a
  `TypedSubset<A>`: field names and literal types in `where` (via a
  field-checked `TypedPredicate<A>`) and `orderBy` are checked against the
  collection's row type. It erases to a plain `Subset` at runtime.
- `ClientEngine.query`/`observe`, `EngineAtoms.liveQuery`, the React `useQuery`
  and the Svelte `query` store now refine their row type to `A` when handed a
  `TypedSubset<A>` (a trust-cast — the read path still never decodes, per
  ADR-0014), so the row type flows through without `row.value as T` casts. Plain
  `Subset` callers are unaffected.
- `ClientEngine.observe(subset, { select, equals? })` returns a projected
  stream that re-emits only when the projected value changes (reference
  equality by default), so a change to a field the projection ignores no longer
  wakes the observer.
- Named-query cache/subscription keys (`ClientEngine`'s named subscriptions and
  `EngineAtoms.namedQuery`) now key on `Hash.canonicalJson` rather than
  `JSON.stringify`, so two structurally-equal args objects with different key
  order resolve to the same subscription entry and the same Atom.
