# ADR-0013: Kotlin-native client port for the JVM and Android

Date: 2026-06-13

Status: Withdrawn (2026-06-18)

> **Withdrawn.** The Kotlin-native client port was removed to keep the project
> web-only; `packages/kotlin` and the `compose-todo` example no longer exist. The
> framework story is now the web bindings (`effect-sync-react`,
> `effect-sync-svelte`). This record is retained for the decision history.

## Context

ADR-0012 added a Swift-native port of the Web client for Apple platforms, on the
premise that the sync model (mutation-log/rebase with CVR-diffed patches,
ADR-0008) is language-agnostic and that embedding a JavaScript runtime to host
the Effect engine is the wrong trade for a native app. The same reasoning applies
to the JVM and Android: a Kotlin app wants coroutines, `Flow`, and
kotlinx.serialization, not a bridged JavaScript stack with a serialization
boundary on every call and a foreign concurrency model.

## Decision

Ship a Kotlin-native port of the Web _client_ implementation as a Gradle package
under `packages/kotlin`, a sibling of the Swift port, rather than a binding over
the TypeScript engine.

- The port mirrors the client engine's semantics exactly — collections, mutators,
  the journal, the optimistic overlay, rebase-as-recomputation, subsets and
  predicates, the protocol messages, and the transport seam — and is validated by
  porting `engine.test.ts` end to end.
- Effect concepts map to Kotlin-native idioms, not to a re-implementation of
  Effect: `Effect` becomes `suspend`, services and layers become interfaces with
  constructor injection, `Ref`/`Semaphore` serialization becomes a `Mutex`, the
  change `PubSub` becomes a `MutableSharedFlow` (so `observe` is a cold `Flow`
  that re-queries on change), schema codecs become `@Serializable` bridged through
  `JsonElement`, tagged errors become a `sealed class`, and the `Atom` live-query
  binding becomes a `Flow<List<T>>` that Compose collects as state.
- The service-worker host and per-tab mirror collapse into a single in-process
  `SyncEngine` observed by many `Flow` collectors. A JVM/Android app is one
  process, so the cross-tab singleton problem does not exist; the `Mutex` provides
  the single writer the service worker provides on the web.
- Durable storage keeps core's design: the `ClientStore` layers over a
  `KeyValueStore` seam. An in-memory store and a file-backed store ship in the
  package; Room/DataStore on Android and SQLDelight on Kotlin Multiplatform back
  the same seam without touching the engine. This is the parallel to the Swift
  port's SwiftData store, drawn at the same boundary core draws it.
- The package is pure Kotlin/JVM with no Android dependency, so it builds and
  tests on any JDK. It lives outside the bun workspace, is not an npm package, is
  not versioned by Changesets, and is excluded from the TypeScript quality gates;
  it is built and tested with `gradle test`.

## Consequences

- JVM and Android apps consume the engine with no JavaScript runtime and a live
  query that is an ordinary `Flow`.
- A third implementation of the same protocol now exists (TypeScript, Swift,
  Kotlin). They are kept in lockstep through shared documentation (CONTEXT.md, the
  ADRs) and parallel test suites; each port carries wire-format tests pinning the
  serialized shapes all three must speak, so any client interoperates with the
  TypeScript server.
- The validation story matches the Swift port: the typed `mutate` entry point is
  checked by the compiler, while `mutateEncoded` reproduces the runtime schema
  check for args arriving over a carrier.
- Server-side concerns (the backend contract, CVR storage, sync rooms, the
  invalidation bus) are out of scope; this is the client, the role the browser
  package plays on the web.
- Keeping the durable store behind a `KeyValueStore` seam means the Android/KMP
  database choice is an application decision, not an engine dependency, and the
  JVM build stays free of the Android SDK.
