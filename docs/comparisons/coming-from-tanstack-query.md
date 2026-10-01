# Coming from TanStack Query / SwiftData / SWR

This guide translates the vocabulary of client-side data libraries —
[TanStack Query](https://tanstack.com/query/latest), [SWR](https://swr.vercel.app),
[Apollo Client](https://www.apollographql.com/docs/react), and Apple's
[SwiftData](https://developer.apple.com/documentation/swiftdata) — into the
legation model. If you arrive expecting a request cache with freshness timers,
most of the machinery you would configure there is either absent (because the
model removes the problem) or lives somewhere you would not think to look.

The short version: legation is not a cache in front of a fetch. Reads observe a
**local store** of typed **collections**; the server ships **patches** that move
that store forward; **live queries** re-run over the store when it changes. This
is the SwiftData `@Query` model, not the TanStack refetch model. Writes are
**mutators** — named intents that run optimistically against the **optimistic
overlay** and authoritatively on your backend, with conflicts resolved by
**rebase** (mutator replay), never by a merge strategy.

`CONTEXT.md` is the internal vocabulary law; this guide is the outward-facing
translation. Where a term below is set in bold, it is defined there.

The snippets assume a `ClientEngine` in scope as `engine` and its `ClientStore`
as `store`, both obtained from `ClientEngine.make(...)` (see the top-level
[README](../README.md) quick start). They are illustrative fragments: effectful
lines are the body of an `Effect.gen(function* () { … })`, and `atoms` /
`engineLayer` refer to the reactivity bindings from `@legation/svelte`. Import surface:

```ts
import { Duration, Effect, Schedule, Schema, Stream } from "effect";
import {
  Aggregate,
  ClientEngine,
  EngineAtoms,
  Hydration,
  Introspection,
  InvalidationBus,
  Mutator,
  Predicate,
  Related,
  Subscriptions,
  Subset,
  Transport,
  Authorization,
} from "@legation/effect";
```

## The mapping

| Reference concept                                       | legation answer                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `staleTime` / freshness / background refetch (TanStack) | No client freshness clock — reads observe the local store; the server ships patches (SwiftData). |
| `gcTime` / query GC (TanStack)                          | `Subscriptions` time-to-live grace (default 5 min, refcounted).                                  |
| `invalidateQueries` (TanStack)                          | Moot on the read path; server-side the invalidation bus is the push-freshness analogue.          |
| `setQueryData` direct writes (TanStack)                 | Writes are intents — a local-only mutator is the sanctioned "direct write".                      |
| Optimistic updates + rollback (TanStack)                | Journal + overlay + rebase does it structurally — no `onMutate`/rollback code.                   |
| Request dedupe (SWR)                                    | Atoms cached per `Subset.hash`; refcounted subscriptions; one store.                             |
| Dependent / serial queries (TanStack)                   | Effect composition + `Related.related` (declared edges), or `Derive.join` (arbitrary keys).      |
| Client-side joins / group-by / distinct (TanStack DB)   | `Derive` combinators — incrementally maintained over already-synced rows; never widen sync.      |
| Middleware (SWR)                                        | Wrap `ClientTransport` (client) or `SyncMiddleware` (server).                                    |
| Normalised entity cache (Apollo)                        | Collections _are_ the normalisation — one row per (collection, id), no `keyFields`.              |
| `ModelActor` / boundary rules (SwiftData)               | The engine host is the serialised writer; encoded rows/mutations cross the mirror boundary.      |
| Suspense (TanStack)                                     | `AsyncResult` states in the atoms; a suspense hook is deliberately not shipped.                  |
| `placeholderData: keepPreviousData` (TanStack)          | `useQuery`/`useNamedQuery`'s `keepPrevious` option (react); automatic on resubscribe (svelte).   |
| `createPacedMutations` (TanStack DB)                    | `Paced.debounce` / `throttle` / `coalesce` — pace rapid mutation intents over the journal.       |

Beyond the direct translations, several capabilities that these libraries hand
you as options have shipped as real APIs — [select projections](#select-projections),
[typed subsets](#typed-subsets), [initial data / prefetch / SSR](#initial-data--prefetch--ssr),
[aggregations](#aggregations), [undo--redo](#undo--redo), [paced mutations](#paced-mutations),
[retries](#retries), [awaiting the server outcome](#awaiting-the-server-outcome), and a
[devtools substrate](#devtools-substrate) — covered after the table.

## `staleTime` / freshness / background refetch

**Reference:** TanStack's [caching lifecycle](https://tanstack.com/query/latest/docs/framework/react/guides/caching)
and [important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults);
SwiftData's [`@Query`](https://developer.apple.com/documentation/swiftui/query).

There is no `staleTime`, no background refetch, and no freshness clock on the
client. A live query observes the local store and re-emits when the rows it
depends on change; the server decides when data is stale and ships a **patch**.
This is SwiftData's `@Query`, where the view tracks the store rather than a
request. "Refetch" is not in the vocabulary — see the avoided terms in
`CONTEXT.md`.

```ts
// Emits now and after every local change. No freshness options to tune.
const todos$ = engine.observe(Subset.make({ collection: "todos" }));
```

## `gcTime` / query GC

**Reference:** TanStack's [`gcTime` default](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults);
Zero's [query lifecycle / `ttl`](https://zero.rocicorp.dev/docs/reading-data).

An unused subscription is not garbage-collected; it is kept for a **time-to-live**
grace period (CONTEXT.md says "time to live / expiry", never "gcTime"). The
`Subscriptions` manager reference-counts holders: when the last holder releases,
the subset is retained for `ttl` (default 5 minutes) so a quick re-subscribe
reuses the already-synced rows, and only then unsubscribed — after which the
next **pull** drops the rows.

```ts
const subs = yield * Subscriptions.make(engine, { ttl: Duration.minutes(2) });
const handle = yield * subs.acquire(Subset.make({ collection: "todos" }));
// ...when the view unmounts:
yield * handle.release; // kept for `ttl`, then unsubscribed; next pull drops the rows
```

## `invalidateQueries`

**Reference:** TanStack's [query invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation).

There is nothing to invalidate on the read path: a live query already reflects
the store, so a write that changes a row re-emits every query over it without a
key to invalidate. The server-side analogue of "this data changed, go get it" is
the **invalidation bus**: a committed write publishes a **change hint**, the
**sync room** matches it against sessions' subscriptions and **fan**s out
**poke**s, and each affected client **pull**s the patch. Correctness never
depends on the hint — a dropped hint only delays the next pull (ADR-0009).

```ts
// Server-side: a committed write publishes a hint; fan-out pokes affected sessions.
const bus = yield * InvalidationBus.InvalidationBus;
yield * bus.publish([{ collection: "todos", ids: ["1"] }]);
```

## `setQueryData` direct writes

**Reference:** TanStack's [`QueryClient.setQueryData`](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientsetquerydata).

Writes are **intents**, not direct store pokes, so there is no `setQueryData`
that reaches in and overwrites a cache entry. The sanctioned "direct write" is a
**mutator** over a collection the client owns and never subscribes to: it writes
the **optimistic overlay** and is journaled like any mutator, but its authoritative
counterpart is a no-op, so server data (which only ever enters via patches) never
contends with it.

```ts
// A local-only "ui" collection: written by a mutator, never synced from the server.
const pin = Mutator.make("ui/pin", Schema.Struct({ id: Schema.String, pinned: Schema.Boolean }));
const mutators = Mutator.registry([
  { mutator: pin, local: (args, writer) => writer.put("ui", args.id, args) },
]);
```

## Optimistic updates + rollback

**Reference:** TanStack's [optimistic updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates).

There is no `onMutate` snapshot and no `onError` rollback to write. A mutation is
journaled, its local effect rendered in the **optimistic overlay**, and dropped
per-mutation exactly when that mutation's authoritative effect (or a **permanent
rejection**) is observed on the next **rebase**. Rollback is structural: on
incoming authoritative state the overlay is discarded, the patch applied, and
pending mutations replayed on top.

```ts
// One call. The overlay renders it immediately; rebase reconciles it later.
yield * engine.mutate("todo/set", { id: "1", title: "ship it", done: false });
```

## Request dedupe (SWR)

**Reference:** SWR's [API — deduping](https://swr.vercel.app/docs/api).

SWR dedupes concurrent requests for the same key within a window. legation has no
requests to dedupe on read: every observer runs over the one local store, and the
reactivity atoms are cached per `Subset.hash`, so mounting the same subset twice
yields the same atom and shares one refcounted subscription.

```ts
const atoms = EngineAtoms.fromLayer(engineLayer);
const a = atoms.liveQuery(Subset.make({ collection: "todos" }));
const b = atoms.liveQuery(Subset.make({ collection: "todos" }));
// a === b — same `Subset.hash`, one atom, one subscription over one store.
```

## Dependent / serial queries

**Reference:** TanStack's [dependent queries](https://tanstack.com/query/latest/docs/framework/react/guides/dependent-queries).

A query that depends on the result of another is ordinary Effect composition —
`yield*` the first, use it to build the second. When the dependence is a
declared relationship, `Related.related` resolves it as a live, incrementally
maintained join and auto-subscribes the narrowed foreign **subset**s, tearing
them down when the scope closes.

```ts
// `registry` is a Collection.CollectionRegistry; "posts" is a declared relationship.
const authorsWithPosts$ =
  yield *
  Related.related(engine, registry, "authors", Subset.make({ collection: "authors" }), ["posts"]);
```

## Middleware (SWR)

**Reference:** SWR's [middleware](https://swr.vercel.app/docs/middleware).

Cross-cutting concerns wrap a seam rather than a fetcher. On the client, decorate
the `ClientTransport` (push/pull/pokes); on the server, implement a
`SyncMiddleware` whose `onPush`/`onPull` intercept requests (the home for
tenancy, cost control, telemetry).

```ts
// Client: a logging transport decorator.
const withLogging = (inner: Transport.ClientTransport): Transport.ClientTransport => ({
  ...inner,
  push: (req) => Effect.tap(inner.push(req), () => Effect.log("push")),
  pull: (req) => Effect.tap(inner.pull(req), () => Effect.log("pull")),
});

// Server: a SyncMiddleware (start from the passthrough and override a leg).
const auditing: Authorization.SyncMiddleware = {
  ...Authorization.passthroughMiddleware,
  onPush: (ctx, req) => Effect.tap(Effect.succeed(req), () => Effect.log("push received")),
};
```

## Normalised entity cache (Apollo)

**Reference:** Apollo's [caching overview](https://www.apollographql.com/docs/react/caching/overview).

Apollo normalises responses into a flat entity cache keyed by `__typename` +
`keyFields`. In legation the **collection** _is_ the normalised store: one **row**
per (collection, id), shared by every **subset** that selects it, with no
`keyFields` to configure — a collection declares its `id` derivation once. A
mutator that writes one row updates it for every view over that collection
simultaneously, because they all read the same store.

```ts
// Two subsets over one collection see the same underlying rows — no denormalised copies.
const open = Subset.make({ collection: "todos", where: Predicate.eq("done", false) });
const all = Subset.make({ collection: "todos" });
```

## `ModelActor` / boundary rules (SwiftData)

**Reference:** SwiftData's [`ModelActor`](https://developer.apple.com/documentation/swiftdata/modelactor).

SwiftData serialises mutation through a `ModelActor` and forbids passing live
model objects across actor boundaries. legation draws the same boundary: the
**engine host** (a service worker per origin, ADR-0010) is the single serialised
writer, and what crosses the boundary to a tab is **encoded** rows and mutations
over the mirror channel — never live objects. Each tab holds a read-only
**mirror** hydrated from the host; live queries and the overlay run synchronously
against that mirror.

```ts
// In @legation/browser: a tab forwards an encoded mutation to the host over the
// mirror channel; the host is the only writer. See TabMirror / MirrorChannel.
```

## Suspense (TanStack)

**Reference:** TanStack's [suspense](https://tanstack.com/query/latest/docs/framework/react/guides/suspense).

The reactivity atoms carry `AsyncResult` states — initial, success, failure — so a
binding renders loading and error branches explicitly. A suspense hook (one that
throws the pending promise for a `<Suspense>` boundary) is deliberately **not**
shipped: it would take a subset and suspend until the first non-initial value.
The states are exposed instead, so the choice of how to gate rendering stays with
the app.

```ts
// From the bindings: `useQuery(read)` returns an AsyncResult, not a thrown
// promise, so the component branches on the state explicitly.
//   const result = useQuery(subset);
//   AsyncResult.match(result, { onInitial, onSuccess, onFailure });
const todos = atoms.liveQuery(Subset.make({ collection: "todos" })); // Atom<AsyncResult<Rows>>
```

## `placeholderData: keepPreviousData` (TanStack)

**Reference:** TanStack's [paginated
queries](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries).

A changed subset (a paging cursor, a filter) selects a different atom whose
`AsyncResult` starts at `Initial` — nothing carries the old rows across by
default, so the UI flashes a loading state between pages. `@legation/svelte`'s
`useQuery`/`useConnection` do this automatically: re-subscribing on an input
change keeps the previous result on screen as a `waiting` `Success`
(`useLiveStream`'s stale-while-revalidate). The bindings' atoms are
cached per `Subset.hash` rather than held in one reactive slot per component,
so the same behaviour is an explicit opt-in: `useQuery`/`useNamedQuery`'s
`keepPrevious` option keeps the previous subset's rows as a `waiting`
`Success` until the new subset's first emission replaces it. Either way, the
consumer discriminates previous ("stale") from fresh data via
`AsyncResult.isWaiting` — no separate `isPlaceholderData` flag.

```ts
// From the bindings:
const orders = useQuery(Subset.make({ collection: "orders", where, first, after }), {
  keepPrevious: true,
});
// AsyncResult.isSuccess(orders) && orders.waiting ⇒ showing the previous
// page's rows while the new page loads.
```

## Shipped as real APIs

These are capabilities the reference libraries expose as options; in legation they
are first-class APIs.

### Select projections

Project each emitted page to a derived value and drop consecutive equal
projections, so a change to a field the projection ignores never re-emits — the
analogue of TanStack's `select`.

```ts
const openCount$ = engine.observe(Subset.make({ collection: "todos" }), {
  select: (rows) => rows.length,
  equals: (a, b) => a === b,
});
```

### Typed subsets

`Subset.for(collection)` binds a subset builder to a collection's row type, so
`where`/`orderBy` field names and literals are checked at compile time and the
observed rows are refined to the row type.

```ts
const Todos = Subset.for(todosCollection);
const open = Todos.make({
  where: (p) => p.eq("done", false),
  orderBy: [{ field: "title", direction: "asc" }],
});
```

### Initial data / prefetch / SSR

`Hydration.dehydrate`/`hydrate` move a whole store snapshot (SSR warm start);
`engine.seed` warms specific confirmed rows before any transport call so
observers render synchronously; `engine.ensureSubset` subscribes and pulls once
if the subset is empty (concurrent calls for the same subset dedupe to one
round-trip).

```ts
const snapshot = yield * Hydration.dehydrate(store); // e.g. serialise on the server
yield * Hydration.hydrate(store, snapshot); // rehydrate into a fresh store
yield *
  engine.seed([
    { collection: "todos", id: "1", version: 1, value: { id: "1", title: "seeded", done: false } },
  ]);
yield * engine.ensureSubset(Subset.make({ collection: "todos" }));
```

### Aggregations

`observeAggregate` folds a subset live (count/sum/min/max/avg), re-emitting only
when the value changes. Local tier only: it sees exactly the rows this client has
synced.

```ts
const openCount$ = engine.observeAggregate(
  Subset.make({ collection: "todos", where: Predicate.eq("done", false) }),
  Aggregate.count
);
```

### Derived queries (joins, group-by, distinct, computed predicates)

TanStack DB's client-side query builder (arbitrary joins, DISTINCT, row-level
group-by, `fn.where`/`fn.select` callbacks, queries-from-queries) maps onto
`Derive`'s bare combinators (ADR-0027). Each takes any `observe`d source — an
engine, a mirror, or **another combinator**, so pipelines compose — and is
incrementally maintained from row deltas, not refolded per change. The result
is an Effect `Stream` and, via `Derive.atom`, an atom on the standard surface,
so `useQuery` / the Svelte `query` store bind it with no new machinery.

```ts
import { Derive } from "@legation/effect/internal";

const teamOpenCounts$ = Derive.map(
  Derive.groupBy(
    Derive.filter(engine.observe(allTodos), (t) => !(t as Todo).done),
    (t) => (t as Todo).team
  ),
  (g) => ({
    team: (g as { key: string }).key,
    open: (g as { rows: ReadonlyArray<unknown> }).rows.length,
  })
);
```

**Local tier only — and it never widens sync.** A derived combinator sees only
the rows this client has already synced; the serializable **Query**/**subset**
tier alone decides what the server ships. The mistake this forbids is filtering
locally and believing the result set is complete: if a derived view needs rows
the client does not hold, widen the **Query** (what syncs), not the combinator
(what is shown).

### Undo / redo

`Undo.make` gives a per-client undo/redo manager. Each entry is a pair of intents
(`execute` / `undo`); both replay through `engine.mutate`, so undo is itself an
optimistic, journaled, rebased mutation.

```ts
const undo = yield * Undo.make(engine);
yield *
  undo.run({
    execute: { mutator: "todo/set", args: { id: "1", title: "ship it", done: true } },
    undo: { mutator: "todo/set", args: { id: "1", title: "ship it", done: false } },
  });
yield * undo.undo; // replays the `undo` intent
```

### Paced mutations

**Reference:** TanStack DB's [`createPacedMutations`](https://tanstack.com/db/latest/docs)
(`debounceStrategy` / `throttleStrategy` / `queueStrategy`, built on
`@tanstack/pacer-lite`) — the same concern this section covers, without a pacer
dependency: `Paced` is ~150 lines over `engine.mutateWithAck` + Effect's own
`Effect.sleep`/`Fiber.interrupt` (#117).

A high-frequency write source — a text field autosaving per keystroke, a
slider, a cart-quantity stepper — journals **one mutation per call** by
default: a 50-keystroke burst is 50 journal entries and 50 overlay replays.
`Paced.debounce`/`Paced.throttle`/`Paced.coalesce` collapse a burst of
same-**key** calls (the key is yours to choose — a row id, typically) down to
a handful of entries, without touching mutations already pushed (ADR-0008's
exactly-once contract: an entry's mutation id, once pushed, is never mutated
or reordered — pacing only ever acts on the still-unpushed tail).

```ts
const setQty = yield * Paced.debounce(engine, "cart/setQty", Duration.millis(300));
// Fifty rapid clicks on one stepper collapse to a leading + a trailing
// journal write for that cart item's key — other items are unaffected.
yield * setQty.call(item.id, { id: item.id, userId, qty: item.qty + 1 });
```

Every strategy always journals _some_ call immediately — the overlay never
waits for the window to close — then compacts:

- **`coalesce`** — no timing: every call journals and immediately drops its
  key's previous still-pending entry. Fully durable (nothing is ever buffered
  only in memory), at the cost of a momentary extra journal entry between a
  call and its compaction.
- **`debounce(duration)`** — the first call after quiet journals immediately
  (the leading edge); calls inside the window only buffer in memory and
  restart the trailing timer. When the window elapses, the latest buffered
  args flush once, superseding the leading entry — two journal writes total
  per burst, however many calls it contained.
- **`throttle(duration)`** — like `debounce`'s leading edge, but the window is
  never reset by later calls: it flushes at most once per `duration` while
  calls keep arriving (so a continuous drag reports progress periodically,
  not only at the very end), then goes idle once a window elapses with
  nothing new buffered.

**Durability tradeoff:** `debounce`/`throttle`'s in-memory buffer (the args of
calls made after the leading edge, before the trailing/periodic flush) is lost
on a crash inside the window — the journal still holds the last successfully
flushed args, not nothing, but not the very latest edit either. This is the
identical tradeoff TanStack DB's own debounce/throttle strategies make.
`coalesce` never loses an edit (everything journals immediately) at the cost
of those short-lived extra entries.

**Mutation ids move (#249):** the backend requires a client's mutation ids to
arrive without gaps, so compaction renumbers the surviving unpushed entries to
keep them contiguous. An id from `mutateWithAck` is therefore only a label for
"now" while the entry is unpushed: its `acknowledged` effect follows it through
the move, and `engineEvents` reports each one (`MutationRenumbered`). Entries a
push has been attempted for — even one that failed — are never dropped or
renumbered (the server may already have applied them), so a call made after a
push is sent simply leaves one extra entry instead of compacting.

**Undo pairing:** wrap a burst of `Paced` calls in `Undo.group` and the whole
burst becomes one undo step, the same way `Undo.group` already coalesces any
run of `manager.run` calls — a debounced text edit undoes in one step, not one
per keystroke.

```ts
yield *
  undo.group(
    Effect.gen(function* () {
      yield* setQty.call(item.id, { id: item.id, userId, qty: 1 });
      yield* setQty.call(item.id, { id: item.id, userId, qty: 2 });
    })
  );
```

### Retries

`ClientEngineOptions.retry` sets the backoff `Schedule` for each network leg
(push, pull, pokes). Only transient transport failures are retried; the default
mirrors TanStack's 1 s → 30 s policy (`ClientEngine.defaultRetryPolicy`).

```ts
const engine =
  yield *
  ClientEngine.make({
    clientId: "c1",
    clientGroupId: "g1",
    mutators,
    retry: {
      push: Schedule.exponential(Duration.seconds(1)),
      pull: ClientEngine.defaultRetryPolicy,
    },
  });
```

### Awaiting the server outcome

`engine.mutateWithAck` journals like `mutate` but returns a handle whose
`acknowledged` effect resolves with the authoritative outcome — `applied` or
`rejected` with a reason — for flows that must block on the backend's verdict.

```ts
const handle = yield * engine.mutateWithAck("todo/set", { id: "1", title: "ship it", done: true });
const outcome = yield * handle.acknowledged; // { _tag: "applied" } | { _tag: "rejected"; reason }
```

### Devtools substrate

`engine.engineEvents` is one unified sync-lifecycle stream (mutation, push, pull,
poke, view-rebuild), and `Introspection` exposes a read-only view over the engine
and its store — the substrate a devtools panel reads.

```ts
const intro = Introspection.make(engine, store);
yield * Stream.runForEach(engine.engineEvents, (event) => Effect.log(event._tag));
```

## See also

- [CONTEXT.md](../CONTEXT.md) — the domain glossary (the internal law this guide translates).
- [README.md](../README.md) — architecture overview and quick start.
- [`docs/adr/`](adr/) — the architecture decisions (ADR-0008 rebase model, ADR-0010 engine host).
