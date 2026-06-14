# EffectSync · SwiftUI example

A SwiftUI todo app driving the [Swift engine](../../packages/swift). It mirrors
the [Compose example](../compose-todo) one-for-one — same demo backend, same
optimistic-write / live-query / push-pull-rebase flow — so the two read as direct
translations of each other.

## What it shows

- **Optimistic writes** — adding or toggling a todo calls `engine.mutate(...)`;
  the row appears or updates immediately, before any sync round trip.
- **Live queries** — the list is a `LiveQuery<Todo>` (`@Observable`), whose `rows`
  re-emit on every local change (mutation, push ack, pull/rebase).
- **Push / pull / rebase** — an in-process demo backend (`DemoServer`) applies
  pushed mutations authoritatively, bumps row versions, and returns CVR-diffed
  patches; "Sync now" runs `push()` then `pull()`, and `runSync()` pushes + pulls
  on connect.

## Run

SwiftUI needs an Apple toolchain, so this builds on macOS (it is not part of the
Linux CI that covers the engine library):

```sh
cd examples/swiftui-todo
swift build        # or: open Package.swift in Xcode and run the TodoApp scheme
```
