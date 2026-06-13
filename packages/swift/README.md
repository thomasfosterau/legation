# EffectSync (Swift)

A Swift-native client port of the effect-sync engine's **Web implementation** —
the client-side modules of [`@thomasfosterau/effect-sync-core`](../core) plus the
browser host in [`@thomasfosterau/effect-sync-browser`](../browser) — built for
Apple platforms (iOS, macOS, tvOS, watchOS) with Swift Concurrency and SwiftData.

It implements the same mutation-log / rebase sync model (ADR-0008): named write
intents flow up, server-computed state patches flow down, and the client rebases
pending intents on top of authoritative state. The semantics are identical; the
idioms are Swift's.

## Why a port, not a binding

The TypeScript engine is written in [Effect](https://effect.website). Rather than
bridge a JavaScript runtime into an app, this package re-expresses the same design
in the language Apple platforms are written in, so it reads like Swift and drops
into a SwiftUI app with no runtime shim.

| effect-sync (Web)                              | EffectSync (Swift)                                              |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `Effect<A, E, R>`                              | `async throws -> A`                                            |
| `Context.Service` + `Layer` injection          | `protocol` + initializer injection                            |
| `effect/Schema` codec (`Schema.Codec<A, I>`)   | `Codable` + `JSONValue` bridging                              |
| `unknown` (encoded row/arg form)               | `JSONValue`                                                    |
| `Ref` / `Semaphore` for serialized state       | `actor` isolation                                             |
| change `PubSub` + `Stream` observe             | per-observer `AsyncStream`                                     |
| `Atom` live-query binding (`LiveQuery.ts`)     | `@Observable` `LiveQuery` for SwiftUI                         |
| `Data.TaggedError` subclasses                  | `SyncError` enum (matched in `catch`/`switch`)               |
| `KeyValueStore`-backed `ClientStore`           | `InMemoryClientStore` + SwiftData `SwiftDataClientStore`     |
| IndexedDB durable store (browser)              | SwiftData durable store (`EffectSyncData`)                    |
| service-worker host + per-tab `TabMirror`      | one in-process `SyncEngine` actor observed by many views      |

### One engine, many observers

The browser deployment runs the engine in a per-origin service worker and gives
each tab an in-memory **mirror** kept current by `BroadcastChannel` broadcasts
(ADR-0010). That split exists to provide a single writer/syncer across multiple
browser tabs that cannot share memory. An Apple app has no such split: one process
holds one `SyncEngine` actor, and many SwiftUI views observe it directly through
`observe(_:)` / `LiveQuery`. The mirror/host machinery collapses into actor
isolation — the same role the service worker plays, provided by the language.

## Targets

- **`EffectSync`** — the platform-agnostic engine. Depends only on Foundation and
  Swift Concurrency, so it builds and tests on every Swift platform, Linux
  included. Contains `SyncCollection`, `Mutator`, `SyncPredicate`, `Subset`, the
  protocol messages, `ClientStore` (+ `InMemoryClientStore`), `ClientTransport`,
  `SyncEngine`, and `LiveQuery`.
- **`EffectSyncData`** — the durable `SwiftDataClientStore`. Guarded by
  `#if canImport(SwiftData)`, so it is a real store on Apple platforms and an
  empty module elsewhere.

## Usage

Define a collection's row type and the mutators that write it:

```swift
import EffectSync

struct Todo: Codable, Sendable, Identifiable {
    let id: String
    let title: String
    let done: Bool
}

let todos = SyncCollection<Todo>(name: "todos")
let setTodo = Mutator<Todo>("todo/set")

let mutators = MutatorRegistry.make { registry in
    // Local handlers are re-runnable: they execute optimistically and again on
    // every rebase.
    registry.register(setTodo) { todo, writer in
        try await writer.put("todos", todo.id, todo)
    }
}
```

Build the engine over a store and a transport, then mutate and observe:

```swift
let store = InMemoryClientStore() // or try SwiftDataClientStore.make()
let engine = SyncEngine(
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators: mutators,
    store: store,
    transport: myTransport
)

await engine.subscribe(Subset(collection: "todos", where: .eq("done", .bool(false))))

// Optimistic write — visible locally immediately, journaled for push.
try await engine.mutate(setTodo, Todo(id: "1", title: "Buy milk", done: false))

// Run the background sync loop (pull on poke, push + pull on reconnect).
await engine.runSync()
```

In SwiftUI, bind a live query straight into a view:

```swift
struct TodoList: View {
    @State private var query: LiveQuery<Todo>

    init(engine: SyncEngine) {
        let openTodos = Subset(collection: "todos", where: .eq("done", .bool(false)))
        _query = State(initialValue: LiveQuery(engine: engine, subset: openTodos, of: Todo.self))
    }

    var body: some View {
        List(query.rows) { todo in Text(todo.title) }
    }
}
```

## Build and test

```sh
cd packages/swift
swift build
swift test
```

The `EffectSync` target and its tests run anywhere Swift runs; `EffectSyncData`
needs an Apple toolchain to exercise the SwiftData store.

## Status

This package was authored alongside the TypeScript engine and faithfully mirrors
its semantics (see the end-to-end tests in `Tests/EffectSyncTests`, which port
`engine.test.ts`). The validation path is Swift's type system: where the Effect
engine validates `unknown` args against a schema at runtime, the typed
`mutate(_:_:)` entry point validates at compile time, and the `mutateEncoded(_:_:)`
entry point reproduces the runtime check for args arriving over a carrier.

## License

MIT
