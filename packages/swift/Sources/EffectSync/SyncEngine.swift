//
//  SyncEngine.swift
//  EffectSync
//
//  The client-side engine (ClientEngine.ts): optimistic mutations into the
//  journal, local materialization (confirmed rows + optimistic overlay),
//  subscriptions, and the sync loop (push journal, pull patches, rebase).
//
//  Rebase is recomputation (ADR-0008): the materialized view is always
//  "confirmed rows with pending mutations replayed on top", so applying a patch
//  and dropping acknowledged mutations IS the rebase — revealed atomically
//  through a single change notification.
//
//  Where the Effect engine is a `Context.Service` built from a `ClientStore`
//  and `ClientTransport` and synchronised with a `Semaphore`, the Swift engine
//  is an `actor`: actor isolation serialises every state transition, and the
//  `Effect` change `PubSub` becomes a set of per-observer `AsyncStream`s.
//

import Foundation

/// An insertion-ordered map of materialized rows — the overlay's working set
/// while a mutator handler runs and the unit `query` reads from.
struct OrderedLocalRows {
    private var order: [RowId] = []
    private var map: [RowId: LocalRow] = [:]

    var values: [LocalRow] { order.compactMap { map[$0] } }

    func get(_ id: RowId) -> LocalRow? { map[id] }

    mutating func put(_ row: LocalRow) {
        if map[row.id] == nil { order.append(row.id) }
        map[row.id] = row
    }

    mutating func remove(_ id: RowId) {
        guard map[id] != nil else { return }
        map[id] = nil
        order.removeAll { $0 == id }
    }
}

/// The local write surface used during materialization. Seeds each touched
/// collection from confirmed rows once, then applies overlay writes on top —
/// `get` reads through the in-progress view exactly like `LocalWriter` in
/// ClientEngine.ts.
private final class MaterializeWriter: LocalWriter, @unchecked Sendable {
    private let store: any ClientStore
    private(set) var collections: [String: OrderedLocalRows] = [:]
    private var seeded: Set<String> = []

    init(store: any ClientStore) {
        self.store = store
    }

    private func ensure(_ collection: String) async throws {
        if collections[collection] != nil { return }
        var ordered = OrderedLocalRows()
        if !seeded.contains(collection) {
            seeded.insert(collection)
            for row in try await store.listRows(collection) {
                ordered.put(LocalRow(id: row.id, value: row.value))
            }
        }
        collections[collection] = ordered
    }

    func put(_ collection: String, _ id: RowId, _ value: JSONValue) async throws {
        try await ensure(collection)
        collections[collection]?.put(LocalRow(id: id, value: value))
    }

    func del(_ collection: String, _ id: RowId) async throws {
        try await ensure(collection)
        collections[collection]?.remove(id)
    }

    func get(_ collection: String, _ id: RowId) async throws -> JSONValue? {
        try await ensure(collection)
        return collections[collection]?.get(id)?.value
    }
}

/// The client-side sync engine.
public actor SyncEngine {
    public let clientId: String
    public let clientGroupId: String

    private let store: any ClientStore
    private let transport: any ClientTransport
    private let mutators: MutatorRegistry

    private var subscriptions: [Subset] = []

    private struct Observer {
        let subset: Subset
        let continuation: AsyncStream<[LocalRow]>.Continuation
    }
    private var observers: [UUID: Observer] = [:]
    private var syncTasks: [Task<Void, Never>] = []

    public init(
        clientId: String,
        clientGroupId: String,
        mutators: MutatorRegistry,
        store: any ClientStore,
        transport: any ClientTransport
    ) {
        self.clientId = clientId
        self.clientGroupId = clientGroupId
        self.mutators = mutators
        self.store = store
        self.transport = transport
    }

    // MARK: Materialization (confirmed rows + replayed overlay)

    private func materialize() async throws -> [String: OrderedLocalRows] {
        let writer = MaterializeWriter(store: store)
        for mutation in try await store.pendingMutations() {
            guard let entry = mutators.entries[mutation.mutator] else {
                throw SyncError.mutator("Unknown mutator: \(mutation.mutator)", mutator: mutation.mutator)
            }
            try await entry.run(mutation.args, writer)
        }
        return writer.collections
    }

    /// Query the current local view (confirmed + overlay).
    public func query(_ subset: Subset) async throws -> [LocalRow] {
        var view = try await materialize()
        // Ensure confirmed rows for the queried collection are loaded even when
        // no pending mutation touched it.
        if view[subset.collection] == nil {
            var ordered = OrderedLocalRows()
            for row in try await store.listRows(subset.collection) {
                ordered.put(LocalRow(id: row.id, value: row.value))
            }
            view[subset.collection] = ordered
        }
        return Subset.apply(view[subset.collection]?.values ?? [], subset)
    }

    /// Query the current local view and decode each row into a typed model.
    public func query<Value: Decodable>(
        _ subset: Subset,
        as type: Value.Type
    ) async throws -> [Value] {
        try await query(subset).map { try $0.decoding(Value.self) }
    }

    // MARK: Subscriptions

    /// Register/replace the engine's subscriptions (synced on next pull).
    public func subscribe(_ subset: Subset) {
        if !subscriptions.contains(where: { $0.identity == subset.identity }) {
            subscriptions.append(subset)
        }
    }

    public func unsubscribe(_ subset: Subset) {
        subscriptions.removeAll { $0.identity == subset.identity }
    }

    // MARK: Mutations

    /// Run a mutator optimistically and journal it for push. Args are validated
    /// by encoding and journaled in their wire/persistence form; handlers always
    /// receive decoded args.
    public func mutate<Args: Codable & Sendable>(_ mutator: Mutator<Args>, _ args: Args) async throws {
        guard mutators.entries[mutator.name] != nil else {
            throw SyncError.mutator("Unknown mutator: \(mutator.name)", mutator: mutator.name)
        }
        let encoded: JSONValue
        do {
            encoded = try JSONValue.encoding(args)
        } catch {
            throw SyncError.mutator("Invalid args for mutator \"\(mutator.name)\"", mutator: mutator.name)
        }
        try await journal(mutator.name, encoded)
    }

    /// Run a mutator whose args are already in encoded (wire) form — the entry
    /// point for remote surfaces forwarding mutations over a carrier. Args are
    /// validated by decoding.
    public func mutateEncoded(_ mutator: String, _ args: JSONValue) async throws {
        guard let entry = mutators.entries[mutator] else {
            throw SyncError.mutator("Unknown mutator: \(mutator)", mutator: mutator)
        }
        try entry.validate(args)
        try await journal(mutator, args)
    }

    private func journal(_ mutator: String, _ encoded: JSONValue) async throws {
        let mutationId = try await store.nextMutationId(clientId)
        let mutation = Mutation(
            clientId: clientId,
            mutationId: mutationId,
            mutator: mutator,
            args: encoded,
            createdAt: Date().timeIntervalSince1970 * 1000
        )
        try await store.appendMutation(mutation)
        publishChange()
    }

    // MARK: Sync (push / pull / rebase)

    private func applyPatch(_ ops: [PatchOp]) async throws {
        for op in ops {
            switch op {
            case .clear:
                try await store.clearRows()
            case let .put(collection, id, version, value):
                try await store.putRow(collection, StoredRow(id: id, version: version, value: value))
            case let .del(collection, id):
                try await store.delRow(collection, id)
            }
        }
    }

    private func acknowledge(_ lastMutationIds: [String: Int]) async throws {
        for (clientId, upTo) in lastMutationIds {
            try await store.acknowledge(clientId, upTo: upTo)
        }
    }

    /// Push pending mutations now.
    public func push() async throws {
        let pending = try await store.pendingMutations()
        if pending.isEmpty { return }
        let response = try await transport.push(
            PushRequest(clientGroupId: clientGroupId, mutations: pending)
        )
        // Effects arrive via the next pull; the ack only trims the journal.
        try await acknowledge(response.lastMutationIds)
        publishChange()
    }

    /// Pull a patch now and rebase.
    public func pull() async throws {
        let cookie = try await store.getCookie()
        let response = try await transport.pull(
            PullRequest(clientGroupId: clientGroupId, cookie: cookie, subscriptions: subscriptions)
        )
        try await applyPatch(response.patch)
        try await acknowledge(response.lastMutationIds)
        try await store.setCookie(response.cookie)
        // Atomic reveal: one change notification after patch + ack (rebase is
        // recomputation in `materialize`).
        publishChange()
    }

    /// Run the sync loop: pull on poke; push+pull on (re)connect. Returns once
    /// the background tasks are started; call `stopSync()` to tear them down.
    public func runSync() {
        let pokeTask = Task { [transport] in
            for await _ in transport.pokes() {
                try? await self.pull()
            }
        }
        let statusTask = Task { [transport] in
            for await status in transport.statusChanges() where status == .connected {
                try? await self.push()
                try? await self.pull()
            }
        }
        syncTasks.append(contentsOf: [pokeTask, statusTask])
    }

    /// Stop the background sync loop.
    public func stopSync() {
        for task in syncTasks { task.cancel() }
        syncTasks.removeAll()
    }

    // MARK: Observation

    /// Live query: emits the result now and after every local change.
    public nonisolated func observe(_ subset: Subset) -> AsyncStream<[LocalRow]> {
        let id = UUID()
        return AsyncStream { continuation in
            continuation.onTermination = { _ in
                Task { await self.removeObserver(id) }
            }
            Task { await self.addObserver(id: id, subset: subset, continuation: continuation) }
        }
    }

    private func addObserver(
        id: UUID,
        subset: Subset,
        continuation: AsyncStream<[LocalRow]>.Continuation
    ) async {
        observers[id] = Observer(subset: subset, continuation: continuation)
        let rows = (try? await query(subset)) ?? []
        continuation.yield(rows)
    }

    private func removeObserver(_ id: UUID) {
        observers[id]?.continuation.finish()
        observers[id] = nil
    }

    /// Recompute and re-emit every observer's rows. The Effect engine publishes
    /// to a single change `PubSub` whose subscribers re-run their query; here we
    /// re-run each observer's query and yield directly.
    private func publishChange() {
        for (_, observer) in observers {
            let subset = observer.subset
            let continuation = observer.continuation
            Task {
                let rows = (try? await self.query(subset)) ?? []
                continuation.yield(rows)
            }
        }
    }
}
