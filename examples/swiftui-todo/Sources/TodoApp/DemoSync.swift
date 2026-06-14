import EffectSync
import Foundation

/// A tiny in-process authoritative backend so the example actually syncs: it
/// applies pushed mutations, bumps a row version on every write, and computes a
/// minimal pull patch against a cookie-keyed view record (the same CVR diff the
/// real server performs). This is the demo equivalent of effect-sync-core's
/// MemoryBackend + SyncServer.
actor DemoServer {
    private struct Row { var version: Int; var value: JSONValue }
    private struct RowKey: Hashable { let collection: String; let id: String }

    private var rows: [String: [RowId: Row]] = [:]
    private var versionCounter = 0
    private var applied: [String: Int] = [:]
    private var cvrByCookie: [String: [RowKey: Int]] = [:]
    private var cookieCounter = 0

    func handlePush(_ request: PushRequest) -> PushResponse {
        for mutation in request.mutations {
            if let last = applied[mutation.clientId], mutation.mutationId <= last { continue }
            if let id = mutation.args["id"]?.stringValue {
                switch mutation.mutator {
                case "todo/set":
                    versionCounter += 1
                    rows["todos", default: [:]][id] = Row(version: versionCounter, value: mutation.args)
                case "todo/remove":
                    rows["todos"]?[id] = nil
                default:
                    break
                }
            }
            applied[mutation.clientId] = mutation.mutationId
        }
        return PushResponse(lastMutationIds: applied)
    }

    func handlePull(_ request: PullRequest) -> PullResponse {
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

/// An in-memory transport bound straight to a `DemoServer`.
struct LoopbackTransport: ClientTransport {
    let server: DemoServer

    func push(_ request: PushRequest) async throws -> PushResponse { await server.handlePush(request) }
    func pull(_ request: PullRequest) async throws -> PullResponse { await server.handlePull(request) }
    func pokes() -> AsyncStream<Poke> { AsyncStream { $0.finish() } }
    func status() async -> ConnectionStatus { .connected }
    func statusChanges() -> AsyncStream<ConnectionStatus> {
        AsyncStream { continuation in
            continuation.yield(.connected)
            continuation.finish()
        }
    }
}

enum DemoSync {
    /// Wire up an engine over an in-memory store and the loopback demo backend.
    static func makeEngine() -> SyncEngine {
        var registry = MutatorRegistry()
        registry.register(setTodo) { todo, writer in try await writer.put("todos", todo.id, todo) }
        registry.register(removeTodo) { args, writer in try await writer.del("todos", args.id) }
        return SyncEngine(
            clientId: "swiftui-demo",
            clientGroupId: "group-demo",
            mutators: registry,
            store: InMemoryClientStore(),
            transport: LoopbackTransport(server: DemoServer())
        )
    }
}
