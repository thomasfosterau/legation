# EffectSync · Compose example

A runnable [Jetpack Compose](https://www.jetbrains.com/lp/compose-multiplatform/)
(Compose for Desktop) todo app driving the [Kotlin engine](../../packages/kotlin).
It builds on a plain JDK — no Android SDK — and the composables are identical to
an Android app's, so it doubles as the Android usage example; only the app shell
(`application { Window { … } }` vs. an `Activity`) differs.

## What it shows

- **Optimistic writes** — adding or toggling a todo calls `engine.mutate(...)`;
  the row appears or updates in the list immediately, before any sync round trip.
- **Live queries** — the list is `engine.observeAs<Todo>(allTodos).collectAsState()`,
  a `Flow` that re-emits on every local change (mutation, push ack, pull/rebase).
- **Push / pull / rebase** — an in-process demo backend (`DemoServer`) applies
  pushed mutations authoritatively, bumps row versions, and returns CVR-diffed
  patches; "Sync now" runs `push()` then `pull()`, and the background
  `runSync(scope)` loop pushes + pulls on connect.

## Run

```sh
cd examples/compose-todo
gradle run
```

The engine library is consumed through an included build
(`includeBuild("../../packages/kotlin")`), so there is nothing to publish first.
