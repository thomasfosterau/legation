# EffectSync (Kotlin)

A Kotlin-native client port of the effect-sync engine's **Web implementation** —
the client-side modules of [`@thomasfosterau/effect-sync-core`](../core) plus the
browser host in [`@thomasfosterau/effect-sync-browser`](../browser) — built with
Kotlin coroutines and kotlinx.serialization for the JVM, Android, and (with a
platform `KeyValueStore`) Kotlin Multiplatform.

It implements the same mutation-log / rebase sync model (ADR-0008): named write
intents flow up, server-computed state patches flow down, and the client rebases
pending intents on top of authoritative state. The semantics are identical; the
idioms are Kotlin's. It is a sibling of the [Swift port](../swift) (ADR-0012).

## Why a port, not a binding

The TypeScript engine is written in [Effect](https://effect.website). Rather than
embed a JavaScript runtime in an app, this package re-expresses the same design
in Kotlin, so it reads like Kotlin and drops into a coroutines/Flow codebase
(Compose, Ktor, Android) with no runtime shim.

| effect-sync (Web)                            | EffectSync (Kotlin)                                       |
| -------------------------------------------- | -------------------------------------------------------- |
| `Effect<A, E, R>`                            | `suspend fun (): A`                                      |
| `Context.Service` + `Layer` injection         | interface + constructor injection                       |
| `effect/Schema` codec (`Schema.Codec<A, I>`) | `@Serializable` + `JsonElement` bridging                 |
| `unknown` (encoded row/arg form)             | `JsonElement`                                            |
| `Ref` / `Semaphore` for serialized state     | `Mutex`-guarded engine state                            |
| change `PubSub` + `Stream` observe           | `MutableSharedFlow` + cold `Flow` observe               |
| `Atom` live-query binding (`LiveQuery.ts`)   | `Flow<List<T>>` (`collectAsState` in Compose)           |
| `Data.TaggedError` subclasses                | `sealed class SyncException`                            |
| `KeyValueStore`-backed `ClientStore`         | `InMemoryClientStore` + `KeyValueClientStore`           |
| IndexedDB durable store (browser)            | `KeyValueStore` seam (Room/DataStore/SQLDelight)        |
| service-worker host + per-tab `TabMirror`    | one in-process `SyncEngine` observed by many collectors |

### One engine, many collectors

The browser deployment runs the engine in a per-origin service worker and gives
each tab an in-memory **mirror** kept current by `BroadcastChannel` broadcasts
(ADR-0010) — a split that exists only to share one writer/syncer across browser
tabs that cannot share memory. An app on the JVM/Android has no such split: one
process holds one `SyncEngine`, and many `Flow` collectors observe it through
`observe(_)`. The mirror/host machinery collapses into a `Mutex` plus a
`SharedFlow` — the same role the service worker plays, provided by coroutines.

### Durable storage

Core's durable `ClientStore` layers over a key-value store. The Kotlin port keeps
that seam (`KeyValueStore`): `InMemoryClientStore` and a `KeyValueClientStore`
over an in-memory or file-backed store ship here, and on Android or Kotlin
Multiplatform you back the same seam with Room/DataStore or SQLDelight — the
engine never changes. This is the parallel to the Swift port's SwiftData store.

## Usage

Define a collection's row type and the mutators that write it:

```kotlin
import au.thomasfoster.effectsync.*
import kotlinx.serialization.Serializable

@Serializable
data class Todo(val id: String, val title: String, val done: Boolean)

val todos = syncCollection<Todo>("todos") { it.id }
val setTodo = mutator<Todo>("todo/set")

val mutators = mutatorRegistry {
    // Local handlers are re-runnable: they execute optimistically and again on
    // every rebase.
    register(setTodo) { todo, writer -> writer.put("todos", todo.id, todo) }
}
```

Build the engine over a store and a transport, then mutate and observe:

```kotlin
val store = InMemoryClientStore() // or KeyValueClientStore(FileKeyValueStore(dir))
val engine = SyncEngine(
    clientId = "client-a",
    clientGroupId = "group-a",
    mutators = mutators,
    store = store,
    transport = myTransport,
)

engine.subscribe(Subset("todos", where = Predicate.eq("done", JsonPrimitive(false))))

// Optimistic write — visible locally immediately, journaled for push.
engine.mutate(setTodo, Todo("1", "Buy milk", false))

// Run the background sync loop (pull on poke, push + pull on reconnect).
val job = engine.runSync(scope)
```

In Jetpack Compose, a live query is just a `Flow` collected as state:

```kotlin
@Composable
fun TodoList(engine: SyncEngine) {
    val openTodos = Subset("todos", where = Predicate.eq("done", JsonPrimitive(false)))
    val todos by engine.observeAs<Todo>(openTodos).collectAsState(initial = emptyList())
    LazyColumn { items(todos) { Text(it.title) } }
}
```

## Build and test

```sh
cd packages/kotlin
gradle test
```

Pure Kotlin/JVM — it builds and tests on any JDK; no Android SDK required.

## Status

This package mirrors the TypeScript engine's semantics, validated by the
end-to-end tests in `src/test` (which port `engine.test.ts`) plus predicate,
subset, and wire-format suites. As in the Swift port, the typed `mutate(_, _)`
entry point is validated by the Kotlin compiler, while `mutateEncoded(_, _)`
reproduces the runtime schema check for args arriving over a carrier.

## License

MIT
