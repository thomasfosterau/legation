# ADR-0012: Swift-native client port for Apple platforms

Date: 2026-06-13

Status: Withdrawn (2026-06-18)

> **Withdrawn.** The Swift-native client port was removed to keep the project
> web-only; `packages/swift` and the `swiftui-todo` example no longer exist. The
> framework story is now the web bindings (`effect-sync-react`,
> `effect-sync-svelte`). This record is retained for the decision history.

## Context

The engine targets the web: the client modules in `effect-sync-core` and the
service-worker host in `effect-sync-browser` are written in Effect and run in
browsers, workers, and Node (ADR-0006, ADR-0010). Apple-platform apps (iOS,
macOS, and siblings) cannot run that stack idiomatically. Embedding a JavaScript
runtime to host the Effect engine would bring a second concurrency model, a
serialization boundary on every call, and an ongoing impedance mismatch with
SwiftUI's data flow.

The sync model itself — mutation-log/rebase with CVR-diffed patches (ADR-0008) —
is language-agnostic. What is web-specific is the _hosting_: the service worker as
a per-origin singleton and per-tab mirrors over `BroadcastChannel`, which exist
only to give multiple tabs one writer/syncer across processes that cannot share
memory.

## Decision

Ship a Swift-native port of the Web _client_ implementation as a SwiftPM package
under `packages/swift`, rather than a binding over the TypeScript engine.

- The port mirrors the client engine's semantics exactly — collections, mutators,
  the journal, the optimistic overlay, rebase-as-recomputation, subsets and
  predicates, the protocol messages, and the transport seam — and is validated by
  porting `engine.test.ts` end to end.
- Effect concepts map to Swift-native idioms, not to a re-implementation of
  Effect: `Effect` becomes `async throws`, services and layers become protocols
  with initializer injection, `Ref`/`Semaphore` serialization becomes `actor`
  isolation, the change `PubSub` becomes per-observer `AsyncStream`s, schema
  codecs become `Codable` bridged through a `JSONValue` encoded form, and the
  `Atom` live-query binding becomes an `@Observable` object for SwiftUI.
- The service-worker host and per-tab mirror collapse into a single in-process
  `SyncEngine` actor observed by many views. Apple apps are one process, so the
  cross-tab singleton problem does not exist; actor isolation provides the single
  writer the service worker provides on the web.
- The package splits by dependency footprint, the same rule as ADR-0006. The
  engine target (`EffectSync`) depends only on Foundation and Swift Concurrency,
  so it builds and tests on any Swift platform including Linux. The durable store
  target (`EffectSyncData`) depends on SwiftData — the Apple-platform analogue of
  the browser package's IndexedDB store — and is guarded by `canImport(SwiftData)`
  so it is an empty module where SwiftData is unavailable.

The Swift package lives outside the bun workspace: it is not an npm package, is
not versioned by Changesets, and is excluded from the TypeScript quality gates. It
is built and tested with `swift build` / `swift test`.

## Consequences

- Apple apps consume the engine with no JavaScript runtime, no serialization
  boundary, and a `LiveQuery` that drops straight into SwiftUI.
- Two implementations of the same protocol now exist. They are kept in lockstep
  through shared documentation (CONTEXT.md, the ADRs) and parallel test suites;
  the wire-format tests pin the serialized shapes both sides must speak, so a
  Swift client and a TypeScript server interoperate.
- The validation story differs by construction: the typed `mutate` entry point is
  checked by the Swift compiler, while the Effect engine validates `unknown` args
  at runtime. The runtime check survives for args arriving over a carrier
  (`mutateEncoded`), which is the path a remote surface uses.
- Server-side concerns (the backend contract, CVR storage, sync rooms, the
  invalidation bus) are out of scope for this package; it is the client, the role
  the browser package plays on the web. A Swift server would be a separate
  decision.
- The port must track protocol changes in core. Because both sides are documented
  against the same glossary and ADRs, a protocol change is a change to a shared
  contract, not to one implementation's private types.
