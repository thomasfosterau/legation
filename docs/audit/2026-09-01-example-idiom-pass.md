# Example idiom pass — library pain points

Date: 2026-09-01

Context: every example was consolidated onto SvelteKit and then rewritten onto
the current API tier (ADR-0021's client-view seam, ADR-0022's Node/Query/
Mutation/Client/Server vocabulary, the `@legation/svelte` rune hooks). Rewriting
four apps end to end surfaced the friction below. Each entry is what an app
author actually hits, not a design objection; where the example had to work
around something, the workaround is named so it can be deleted when the library
closes the gap.

## 1. Two API generations ship side by side, and the older one reads as current

`@legation/svelte`'s package root exports `Query.query` / `Mutation.getMutate` /
`Runtime.setEngineRuntime` — `Readable` stores over `Subset` and `ClientView`.
The current tier is `@legation/svelte/Runes` over `Client` and `Query.Read`.
Nothing in the older surface says "superseded": the root README documents the
store API first and the runes as an addendum, `Mutator` is only marked
`@deprecated` in the `@legation/effect` index, and `Collection.make` +
`Subset.make` carry no such marker at all even though `Node.registry` derives
collections from the graph now.

Three of the four examples had been written against the older tier and none of
them looked stale. **Suggestion:** deprecate `Query`/`Mutation`/`Runtime`'s
engine-runtime surface in the bindings the way `Mutator` is deprecated in the
core, and lead the bindings README with the rune hooks.

## 2. `Client.make` is the documented front door, but two capabilities force you off it

`Client.make({ nodes, mutations })` is genuinely zero-wiring: it resolves the
store and transport from context, and it starts the sync loop, so the "app
forgot `runSync`" bug really is gone. But it does not hand back the
`ClientEngine`, and two things need one:

- **Undo/redo** — `Undo.make(engine)` takes a `ClientEngine`, though its only
  use of it is `engine.mutate(mutator, args)`, which `Client` also has.
- **Devtools** — `Devtools.make(engine, store, …)`.

Both are also behind `@legation/effect/internal`. So `todo` and `northwind`
build the engine by hand (`ClientEngine.make` + `Effect.forkScoped(runSync)`)
and wrap it with `Client.fromView(nodes, ClientView.fromEngine(engine))` just to
keep a headline feature. **Suggestion:** widen `Undo.make` to accept anything
with `mutate` (or a `Client`), and either return the engine from `Client.make`
or expose an `engine`-shaped capability on `Client` for devtools.

## 3. Writes do not reach the server unless you opt into `syncLoop.pushDebounce`

`SyncLoopOptions.pushDebounce` and `pullInterval` are both optional and both
default to off. With a transport connected and the sync loop running, a
journaled mutation therefore sits unpushed until a reconnect, a poke, or an
explicit `engine.push`.

This is not theoretical: every client-only example shipped without
`pushDebounce`, so an _online_ client showed a permanently growing "N pending"
journal, and the demos only looked correct because toggling offline→online
flushed them. For an offline-first library whose headline is "writes converge",
push-on-write is the behaviour an author assumes. **Suggestion:** default
`pushDebounce` to a small value (the examples use `300 millis`) and let apps opt
out, rather than the reverse.

## 4. The node graph hard-codes `id` as the identity field

`Node.registry` derives each collection with `id: (value) => value.id`, and
`Edge.one(target, { via })` matches `via` against the target's `id`.
`Collection.make` allowed any extractor (`id: (user) => user.username`).

Conduit identifies users by username and articles by slug, so porting
`realworld` to the graph meant adding an `id` attribute alongside each natural
key and keeping the two equal at every write site (`userRow`, `articleRow` in
`examples/realworld/src/lib/domain.ts`). It works and it is honest, but it is
duplicated state a schema cannot enforce. **Suggestion:** let `Node.make` name
its identity attribute (`id: "username"`), defaulting to `id`.

## 5. A read's rows are untyped, so every app re-casts what the graph already knows

`Client.ResolvedRow` is `{ id: string; value: unknown; related: Record<string,
RelatedValue> }`. The node graph carries the full row schema and every edge's
target, so both could be inferred from the `Query.Read` — but nothing is, and
`RelatedValue` collapses one/many/absent into a single union.

Every example ends up with the same two helpers:

```ts
const one = <T>(row, edge) => (row.related[edge] as T | null | undefined) ?? null;
const many = <T>(row, edge) => (row.related[edge] as ReadonlyArray<T> | undefined) ?? [];
```

plus `row.value as Product` at each use. The casts are unchecked: renaming an
edge or changing a node's shape compiles cleanly and fails at runtime.
**Suggestion:** thread the node types through `Query.Read` so `useQuery` returns
typed rows, with `include`d edges typed per their kind.

## 6. There is no way to _not_ run a hook

Rune hooks must be called during component initialisation, and there is no
`enabled` / `skip` option. Two screens genuinely want a conditional read — the
order-lines panel only when a row is expanded, the editor only when editing an
existing article — and both had to spell it as a read that matches nothing:

```ts
const lineRows = useQuery(() => orderLines(open ?? "")); // northwind
const rows = useQuery(() => articleBySlug(slug ?? "")); // realworld
```

That registers a real (empty) window and a real subscription for a read the UI
does not want. **Suggestion:** let the thunk return `undefined` to mean "no read
right now", leaving `current` at `Initial`.

## 7. Undo/redo has no rune equivalent

`undoControls(manager)` returns `Readable` stores. In an otherwise store-free
runes component that is the one place a `$` auto-subscription survives
(`examples/todo/src/routes/[[filter=filter]]/+page.svelte`). **Suggestion:** a
`useUndo(manager)` hook on the `Runes` subpath, matching the rest.

## 8. Layer composition is where the seams pay off — once you find them

The good news, recorded because it is the shape other apps should copy:
`Client.make`'s "options → context → defaults" resolution makes the store and
transport ordinary layers, so `realworld`'s whole bootstrap is one
`Layer.effect(Client.Client)(…).pipe(Layer.provide(storeLayer),
Layer.provide(transportLayer), Layer.provideMerge(rigLayer))` and a
`ManagedRuntime` over it. That replaced a `new Promise` + `Effect.runFork` +
`Effect.never` bootstrap in all three client-only examples — the scope is the
runtime's, and nothing has to be kept alive by hand. Similarly `Server.make`
collapsed four `provideService` calls plus `Cvr.makeMemoryStore` and
`InvalidationBus.makeInProcess` into one call with working defaults, and
`server.broadcast` replaced direct `bus.publish` for out-of-band writes.

None of that is discoverable from the examples that existed before this pass,
which is the real finding: **the substrate was ahead of its own demos.**
`Transport.makeInMemory` + `Transport.simulateOffline` had already generalised
the hand-rolled offline transports (per `.changeset/transport-simulate-offline.md`),
and `todo` still hand-rolled one.

## 9. The commerce example's server was never typechecked

`bun run typecheck:examples` runs each example's `check` script, and
`commerce`'s was `svelte-check --tsconfig ./tsconfig.json`. That tsconfig
extends SvelteKit's generated one, whose `include` covers `src/`, `tests/` and
`vite.config.ts` — but not `server/`, which is a third of the example. Fixed
here by adding `tsconfig.server.json` and chaining it into `check`.
