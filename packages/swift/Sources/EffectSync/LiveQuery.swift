//
//  LiveQuery.swift
//  EffectSync
//
//  Read-side UI integration (LiveQuery.ts). The Effect engine binds a live
//  query — a subset observed against the local view — to an `Atom` whose value
//  re-emits on every local change. The idiomatic Swift surface for that is an
//  `@Observable` object SwiftUI can render directly: it subscribes to the
//  engine's `observe(_:)` stream, decodes each emission into a typed model, and
//  publishes the result on the main actor.
//
//  It compiles only where the `Observation` module is available (Apple
//  platforms / recent toolchains); the underlying `SyncEngine.observe(_:)`
//  stream is always available for non-SwiftUI consumers.
//

#if canImport(Observation)

    import Foundation
    import Observation

    /// A live query bound to a `SyncEngine`: `rows` re-emits on every local
    /// change (patch applied, overlay changed), ready to drive SwiftUI.
    ///
    /// ```swift
    /// @State private var todos = LiveQuery(engine: engine, subset: openTodos, of: Todo.self)
    /// // ...
    /// List(todos.rows) { todo in Text(todo.title) }
    /// ```
    @MainActor
    @Observable
    public final class LiveQuery<Value: Decodable & Sendable> {
        /// The current decoded rows for the observed subset.
        public private(set) var rows: [Value] = []
        /// The most recent decoding/query error, if any.
        public private(set) var error: Error?

        // Written once in `init` (on the main actor) and read once in the
        // nonisolated `deinit`; `nonisolated(unsafe)` lets `deinit` cancel it
        // without the main-actor isolation a stored property would otherwise
        // require.
        nonisolated(unsafe) private var task: Task<Void, Never>?

        public init(engine: SyncEngine, subset: Subset, of type: Value.Type = Value.self) {
            task = Task { [weak self] in
                for await localRows in engine.observe(subset) {
                    guard let self else { return }
                    do {
                        self.rows = try localRows.map { try $0.decoding(Value.self) }
                        self.error = nil
                    } catch {
                        self.error = error
                    }
                }
            }
        }

        deinit {
            task?.cancel()
        }
    }

#endif
