//
//  TestSupport.swift
//  EffectSyncTests
//
//  A minimal authoritative backend and loopback transport, enough to drive the
//  client engine end to end: client mutates optimistically → journal → push →
//  backend applies authoritatively → CVR diff → pull patch → rebase. This is
//  the Swift counterpart of the MemoryBackend + SyncServer + in-memory
//  transport the Effect `engine.test.ts` wires up.
//

import EffectSync
import Foundation

// MARK: - Fixtures

struct Todo: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let title: String
    let done: Bool

    init(_ id: String, _ title: String, _ done: Bool) {
        self.id = id
        self.title = title
        self.done = done
    }
}

struct RemoveArgs: Codable, Sendable {
    let id: String
}

let todoSet = Mutator<Todo>("todo/set")
let todoRemove = Mutator<RemoveArgs>("todo/remove")
let allTodos = Subset(collection: "todos")

/// The shared client-side mutator registry. A fresh registry per call keeps the
/// duplicate-name precondition happy across independent test clients.
func makeRegistry() -> MutatorRegistry {
    MutatorRegistry.make { registry in
        registry.register(todoSet) { todo, writer in
            try await writer.put("todos", todo.id, todo)
        }
        registry.register(todoRemove) { args, writer in
            try await writer.del("todos", args.id)
        }
    }
}

// MARK: - Backend

/// A mutable view of authoritative rows handed to backend handlers. `put` bumps
/// the global version counter on every write — the row-version token the CVR
/// diffs against.
struct BackendWriter {
    struct Row { var version: Int; var value: JSONValue }
    var rows: [String: [RowId: Row]]
    var counter: Int

    mutating func put(_ collection: String, _ id: RowId, _ value: JSONValue) {
        counter += 1
        rows[collection, default: [:]][id] = Row(version: counter, value: value)
    }

    mutating func del(_ collection: String, _ id: RowId) {
        rows[collection]?[id] = nil
    }
}

/// The authoritative backend handlers, keyed by mutator name.
let backendHandlers: [String: @Sendable (JSONValue, inout BackendWriter) -> Void] = [
    "todo/set": { args, writer in
        if let id = args["id"]?.stringValue { writer.put("todos", id, args) }
    },
    "todo/remove": { args, writer in
        if let id = args["id"]?.stringValue { writer.del("todos", id) }
    },
]

/// A tiny authoritative server with exactly-once mutation application and a
/// cookie-keyed CVR that computes minimal pull patches.
actor TestServer {
    private struct RowKey: Hashable {
        let collection: String
        let id: String
    }

    private var rows: [String: [RowId: BackendWriter.Row]] = [:]
    private var versionCounter = 0
    /// Per-client highest applied mutation id (exactly-once, in-order).
    private var applied: [String: Int] = [:]
    /// Snapshot of delivered `{row -> version}` per issued cookie.
    private var cvrByCookie: [String: [RowKey: Int]] = [:]
    private var cookieCounter = 0

    private let allowed: Set<String>
    private let handlers: [String: @Sendable (JSONValue, inout BackendWriter) -> Void]

    init(
        allowed: Set<String> = ["todos"],
        handlers: [String: @Sendable (JSONValue, inout BackendWriter) -> Void] = backendHandlers
    ) {
        self.allowed = allowed
        self.handlers = handlers
    }

    func handlePush(_ request: PushRequest) -> PushResponse {
        var writer = BackendWriter(rows: rows, counter: versionCounter)
        for mutation in request.mutations {
            if let last = applied[mutation.clientId], mutation.mutationId <= last { continue }
            handlers[mutation.mutator]?(mutation.args, &writer)
            applied[mutation.clientId] = mutation.mutationId
        }
        rows = writer.rows
        versionCounter = writer.counter
        return PushResponse(lastMutationIds: applied)
    }

    func handlePull(_ request: PullRequest) throws -> PullResponse {
        for subset in request.subscriptions where !allowed.contains(subset.collection) {
            throw SyncError.authorization(
                "Collection not allowed: \(subset.collection)",
                collection: subset.collection
            )
        }

        // Desired view: the union of every subscription's evaluated rows.
        var desired: [RowKey: (version: Int, value: JSONValue)] = [:]
        for subset in request.subscriptions {
            let collectionRows = rows[subset.collection] ?? [:]
            let localRows = collectionRows.map { LocalRow(id: $0.key, value: $0.value.value) }
            for row in Subset.apply(localRows, subset) {
                let version = collectionRows[row.id]!.version
                desired[RowKey(collection: subset.collection, id: row.id)] = (version, row.value)
            }
        }

        let previous = request.cookie.flatMap { cvrByCookie[$0] } ?? [:]
        var patch: [PatchOp] = []
        for (key, entry) in desired where previous[key] != entry.version {
            patch.append(
                .put(
                    collection: key.collection,
                    id: key.id,
                    version: .number(Double(entry.version)),
                    value: entry.value
                )
            )
        }
        for (key, _) in previous where desired[key] == nil {
            patch.append(.del(collection: key.collection, id: key.id))
        }

        cookieCounter += 1
        let cookie = String(cookieCounter)
        cvrByCookie[cookie] = desired.mapValues { $0.version }
        return PullResponse(cookie: cookie, patch: patch, lastMutationIds: applied)
    }
}

// MARK: - Transport

/// An in-memory `ClientTransport` bound directly to a `TestServer` — the
/// loopback carrier for tests and same-process client/server setups.
struct LoopbackTransport: ClientTransport {
    let server: TestServer
    let clientGroupId: String

    func push(_ request: PushRequest) async throws -> PushResponse {
        await server.handlePush(request)
    }

    func pull(_ request: PullRequest) async throws -> PullResponse {
        try await server.handlePull(request)
    }

    func pokes() -> AsyncStream<Poke> {
        AsyncStream { $0.finish() }
    }

    func status() async -> ConnectionStatus { .connected }

    func statusChanges() -> AsyncStream<ConnectionStatus> {
        AsyncStream { continuation in
            continuation.yield(.connected)
            continuation.finish()
        }
    }
}

// MARK: - Client wiring

func makeClient(
    _ server: TestServer,
    _ name: String
) -> (engine: SyncEngine, store: InMemoryClientStore) {
    let store = InMemoryClientStore()
    let transport = LoopbackTransport(server: server, clientGroupId: "group-\(name)")
    let engine = SyncEngine(
        clientId: "client-\(name)",
        clientGroupId: "group-\(name)",
        mutators: makeRegistry(),
        store: store,
        transport: transport
    )
    return (engine, store)
}
