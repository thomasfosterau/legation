# ADR-0027: Client-local incremental view maintenance — the Patch-op delta model, and the per-module seams over a shared operator core

Date: 2026-07-09
Status: Accepted (issue #108)

## Context

Issue #108 was the umbrella for a differential-dataflow IVM programme: close
the read-layer expressiveness gap `docs/comparisons/tanstack.md` concedes
("genuinely more expressive than legation's read layer, and the strongest
reason to pick it") by pushing incremental view maintenance up from the one
layer that already had it (`LiveView`'s single maintained subset) into the
layers that still refolded or rebuilt — aggregates, joins, the optimistic
overlay, predicate evaluation, ordered windows.

The original proposed direction (step 2 of #108) was a **literal operator
core**, modelled on `@tanstack/db-ivm`: a self-contained internal module of
`MultiSet = Array<[value, ±multiplicity]>` deltas pushed through a static DAG
of `map / filter / join / reduce / distinct / orderedWindow` operators run to
quiescence — d2ts with the Naiad time dimension removed.

That is not what shipped. The five children landed and merged as **targeted
per-module machinery**, each keeping its existing public API:

- **#109** delta-maintains the optimistic overlay, killing `Rebuild`-on-pending.
- **#110** (`Aggregate`) maintains ungrouped and grouped aggregates with a
  mutable running-fold `Bucket` plus a `byId` map to classify each delta.
- **#111** (`Related.makeJoinEngine`) propagates row deltas through edge joins
  with a mutable `fk → rows` bucket index and a reverse
  `(collection, key) → base ids` index.
- **#112** (`LiveView` + new `OrderedTree`, `FractionalIndex`) maintains ordered
  windows in a persistent weight-balanced tree with stable position keys; its
  collation question was settled separately as ADR-0026.
- **#113** (`CollectionIndex`) adds secondary field-value indexes that plan a
  predicate against `O(hits)` candidates instead of a full scan.

The 2026-07-09 verification pass confirmed all five against their acceptance
criteria, and made a program-level observation: **the shared multiset/
operator-DAG core of step 2 never got built, and may no longer be the right
shape.** The de-facto shared seams are the `ViewChange.Patch` op vocabulary and
`LiveView.put`/`del` folding, plus the now-proven internal modules `OrderedTree`,
`CollectionIndex`, `Related.makeJoinEngine`, and `Aggregate`'s `State`/`Bucket`.

This ADR records the delta model **as it actually shipped**, draws the boundary
between it and the serializable wire tier, folds in #114's "derived reads never
widen sync" two-tier rule, and settles the one open architectural question the
umbrella left: **extract a shared operator layer from the proven machinery, or
bless the seams?** ADR-0026 already recorded the collation slice; this is the
IVM model/boundaries ADR the umbrella's acceptance criteria still wanted.

## Decision

### 1. The delta currency is the `Patch`-op vocabulary, on a single timeline

The engine's change hub already carries what an operator graph would want as
input: seq-numbered row deltas. A `ViewChange.Patch` is an ordered array of
`Put { collection, id, value }` / `Del { collection, id }` ops
(`ClientEngine.ts`). Confirmed-pull ops and the optimistic overlay's `OverlayOp`
are **structurally interchangeable** here — the overlay op carries no server
version, and `LiveView` folding never reads one — so one op vocabulary is the
delta currency for both the confirmed and the optimistic path.

This is a **version-free, single-timeline** model, and deliberately so:

- **No multiplicities.** A delta is a keyed `Put`/`Del`, not a
  `[value, ±count]` multiset entry. Each maintained view keys its own state by
  row id and classifies a `Put` as insert / update / no-longer-match / no-op by
  consulting that state (`LiveView` via its `byId` tree; `Aggregate` via `byId`;
  `Related` via last-seen `rowsById`). Row identity, not signed multiplicity, is
  the primitive — which is what a normalized replica already gives us (a node
  lives once in its collection, ADR-0022).
- **No timestamps, frontiers, or `iterate`.** There is exactly one timeline of
  deltas per collection, ordered by the hub's monotonic seq. The recursive
  fixpoint machinery Naiad/d2ts carry (for iterative dataflow across logical
  times) has no counterpart here and is an explicit non-goal.
- **Seq-gap → `Rebuild`, losslessly.** Backpressure may shed a `Patch` only
  behind a seq gap, and the gap forces a `Rebuild` before the view is next read
  (CONTEXT.md hub table). Incremental maintenance is therefore an optimization
  over a correctness path that is always re-materialization; no maintained view
  needs to be individually crash-consistent.

Per-module incremental **state** stays per-module and shaped for its job —
persistent `OrderedTree`s for `LiveView` (so an out-of-window change costs the
same as an in-window one, and positions survive untouched); a mutable
`Bucket` + `byId` for `Aggregate` (O(1) amortized folds, single-owner behind a
`Ref`); mutable buckets + a reverse index for `Related`; hash + sorted runs for
`CollectionIndex`. There is no single state representation, and this ADR does not
impose one.

### 2. `Subset`/`Predicate` are the serializable wire tier; IVM is client-local

The law this must not break (ADR-0015, ADR-0022): **`Subset`/`Predicate` are the
serializable, auth-narrowable sync vocabulary.** A `Query` compiles to a plan of
sync windows; one foreign key powers the join, the sync window, the auth scope,
and the fan-out topic; a client predicate can only narrow what the mandatory
server auth filter allows.

Everything in section 1 is **client-local read machinery behind `observe`**. It
never crosses the wire, never registers a CVR window, never participates in
auth. The engine still "speaks flat subsets" outward (ADR-0022); IVM is how the
client keeps the _result_ of an already-authorized subset current between pulls,
nothing more. TanStack DB draws the same line — its IR is optimizer-internal and
predicate pushdown to the sync layer is a separate, narrower channel; our
subsets already _are_ that channel, natively (ADR-0024).

Concretely, the boundary is:

| Tier                 | Vocabulary                                                | Crosses the wire? | Auth-relevant?              |
| -------------------- | --------------------------------------------------------- | ----------------- | --------------------------- |
| **Sync**             | `Query` → `Subset`/`Predicate` plan of windows            | Yes               | Yes (auth filter AND-ed in) |
| **Client-local IVM** | `Patch` ops folded into per-module state behind `observe` | No                | No                          |

### 3. Derived reads never widen sync (the two-tier rule, folded in from #114)

#114 builds a client-local expressiveness tier — composable combinators
(`filter` with an arbitrary JS predicate, `map`/select, `join` on arbitrary key
equality, `groupBy` → rows, `distinct`, ordered window) over observed sources,
giving queries-from-queries. Its brief assigns the architectural rule to _this_
ADR rather than a second one:

**A derived combinator only ever sees rows the client already holds, and never
changes what the server ships.** What syncs is decided solely by the
serializable `Query`/`Subset` tier underneath (section 2). Derived
expressiveness reshapes a materialized result; it does not widen the window that
produced it.

The failure mode this forbids, stated plainly for the docs: **filtering (or
joining, or grouping) locally and believing the resulting set is complete.** A
derived `filter` that keeps rows where `priority > 3` is correct only over the
rows the underlying subset already synced; if the intent is "all high-priority
rows in the collection," the _subset_ must say so, because the server ships what
the subset asks for and nothing more. An arbitrary-JS derived predicate is not
analyzable by the auth filter and so can never be a pushdown — by construction it
stays above the sync tier.

This makes the read layer two honest tiers: a **narrow, serializable,
auth-narrowable sync tier** (capped at what a server auth filter can safely AND
in) and a **wide, client-local, never-synced derived tier** (arbitrary JS, no
serialization constraint) — the split TanStack DB demonstrates, replacing the
old "cap both together" concession.

### 4. Re-scope: bless the per-module seams; do not extract a shared operator core

**We do not build step 2's operator core.** The de-facto seams are the
architecture. The decision is made on evidence from the five merged
implementations, not aesthetics — the test set by #108 was: extract only if
there is real duplication across the five that a shared layer would remove, or
#114's combinators genuinely cannot be built cleanly on the existing seams.
Neither holds.

**There is no shared operator representation to consolidate.** Each of the five
is a bespoke stateful fold welded to its own vocabulary, and they do not overlap
in a way a common layer would collapse:

- `LiveView` folds `Predicate.test(subset.where)` + `Subset.comparator(orderBy)`
  into two _persistent_ `OrderedTree`s.
- `Aggregate` folds into a _mutable_ running `Bucket` keyed by aggregate kind,
  with `byId` to classify transitions and a bounded refold only when `Min`/`Max`
  loses its extremum.
- `Related.makeJoinEngine` maintains _mutable_ `fk → rows` buckets + a reverse
  index, is coupled to `Strategy`/`Target`/`RelatedRow` edge hydration, and
  uniquely consumes _page snapshots_ that it re-diffs internally to recover
  deltas.
- `CollectionIndex` is a query _planner_ over hash + sorted runs — it answers
  point/range lookups, it is not a delta-in/delta-out operator at all.

None represents deltas as `[value, ±multiplicity]`; none composes as a DAG. The
one substrate genuinely shared across them — the persistent ordered container —
is **already extracted** as the generic, pure-data `OrderedTree` module. The
residual echoes (the `Predicate.test` → insert/update/remove/no-op transition
classification shared by `LiveView.put` and `Aggregate.applyPut`; the
partition-by-key-drop-empty-group shape shared by `Related`'s fk buckets and
`Aggregate`'s grouped `State`) are a few lines each, entangled with each
module's state update, and carry _different per-group payloads_ (a row list vs a
running fold). That is not module-scale duplication a shared layer would remove;
extracting it would produce a thin helper, and refactoring the merged children
onto it is explicitly out of scope this session anyway.

**#114's combinators are the operator layer — and #114 is its only consumer.**
Step 2's proposed operator set (`map / filter / join / reduce / distinct /
orderedWindow`) and #114's deliverable set (`filter, map/select, join, groupBy →
rows, distinct, ordered window`) are the _same layer_. Extracting a separate
`#108` operator module ahead of #114 would create an abstraction whose only
consumer is #114 — the five children are coupled to their own vocabularies and
will not be refactored onto it. A speculative abstraction with one consumer is
the exact failure mode CLAUDE.md tells us to avoid.

**#114 builds cleanly on the existing seams.** Its combinators must be written
as new generic functions regardless of where they live: `LiveView`'s filter is a
serializable `Predicate`, not an arbitrary JS callback; `Related`'s join is
edge-specific, not a general two-source key-equality join; `Aggregate`'s groupBy
yields scalar folds, not grouped rows. Those new functions compose directly on
seams that already exist and are proven:

1. **The row-level delta feed** — #115's `observeChanges(subset): Stream<Array<RowChange>>`
   (enter / update / exit), the public output seam, is the delta _input_ for a
   derived pipeline. Where #115 has not merged, a combinator falls back to
   diffing `ClientView.observe` page streams (the same re-diff `Related` does
   internally today).
2. **`OrderedTree`** (+ `FractionalIndex`) — the generic persistent tree with
   `rank`/`slice`, already standalone, is the substrate for the ordered-window
   combinator.
3. **`Predicate`/`Subset`** — the serializable sync tier _underneath_, untouched;
   the derived tier sits above materialization and never edits what syncs.
4. **`Subscriptions`** — the refcounting manager for composed lifetime (a derived
   pipeline holds its sources' handles, releasing on scope close — the same
   discipline `Related` uses), and the engine-atoms caching surface for exposing
   a derived result as an atom.
5. **`Related.makeJoinEngine` and `Aggregate`'s `State`/`Bucket`** as _reference
   implementations to mirror_ — the keyed-bucket-plus-reverse-index join
   technique and the running-fold-plus-`byId` reduce technique are proven; #114
   reuses the technique, not the coupled code.

If a _second_ consumer of a generic operator ever appears — a need that would
share #114's combinators rather than merely resemble them — the extraction
becomes evidence-based and this decision should be revisited. It is not evidence-
based today.

### 5. The delta feed is the public output seam (coordinate with #115)

`observeChanges` (#115, in flight in another session) is the one public surface
for row-level deltas — the enter/update/exit feed that `LiveView`'s `put`/`del`
already compute internally and that #112 left position hooks for ("no delta
consumer yet"). This ADR names it as the public output seam of the model and the
delta input for #114; it does **not** design, build, or modify `observeChanges`
— that is #115's work.

## Consequences

- **The IVM programme is complete without a literal operator core.** #108's
  step-2 acceptance criterion ("operator core exists behind
  `@legation/effect/internal` with property tests") is resolved as
  _superseded_: the machinery shipped per-module, each with its own property
  tests and benchmarks, and the shared substrate that warranted extraction
  (`OrderedTree`) is already a module.
- **#114 is unblocked and its precondition changes.** Its hard precondition
  ("wait for the #108 operator core") is amended to "compose these named seams
  directly" (section 4). The maintainer's `#114` rulings — bare combinators, no
  new noun, extend this ADR rather than write a second one — are unaffected.
- **No wire, protocol, `Subset`, or `Predicate` change** — from this ADR or from
  the whole programme. The delta model is entirely behind `observe`.
- **The two-tier read model is now documented law.** #114 updates
  `docs/coming-from-tanstack-query.md` and `docs/comparisons/tanstack.md`,
  replacing the "expressiveness gap" concession with the two-tier story anchored
  here.
- **Known limitations remain tracked, not silently closed** (carried from the
  children): engine-level reactive window `retarget` wiring (`LiveView` computes
  a widened slice purely, but nothing feeds a widened `limit` to an open
  subscription yet); secondary indexes are bypassed while any mutation is pending
  (per-collection overlay-touch scoping is future work); `move` deltas + stable
  position keys over `observeChanges` land with #115/#112 follow-through.

### Non-goals (explicit)

- No Naiad/d2ts timestamps, frontiers, or `iterate` — single timeline only.
- No `[value, ±multiplicity]` multiset delta currency — keyed `Put`/`Del` on row
  identity.
- No shared operator-DAG core module — the per-module seams are the
  architecture; combinators land with their consumer (#114).
- No wire, protocol, `Subset`, `Predicate`, or query-language change in this
  programme.
- No refactor of the merged children (#109–#113) onto any shared layer in this
  session — filed as a follow-up if a second consumer ever justifies extraction.
