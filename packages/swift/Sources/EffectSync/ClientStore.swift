//
//  ClientStore.swift
//  EffectSync
//
//  The client's durable state: confirmed rows per collection, the journal of
//  pending mutations, the per-client mutation-id counters, and the pull cookie
//  (ClientStore.ts). Every engine state transition is persisted here so a killed
//  host rehydrates losslessly.
//
//  Rows stored here are *confirmed* (authoritative) state only; optimistic
//  effects live in the overlay and are recomputed by replay, never persisted.
//
//  This file ships the in-memory implementation (an `actor`, so it is safe to
//  share across tasks); the durable SwiftData-backed implementation lives in the
//  `EffectSyncData` target.
//

import Foundation

/// The client's durable store. Async throughout — a real implementation talks
/// to disk; the engine awaits every transition.
public protocol ClientStore: Sendable {
    // Confirmed rows
    func getRow(_ collection: String, _ id: RowId) async throws -> StoredRow?
    func listRows(_ collection: String) async throws -> [StoredRow]
    func putRow(_ collection: String, _ row: StoredRow) async throws
    func delRow(_ collection: String, _ id: RowId) async throws
    func clearRows() async throws

    // Journal
    func appendMutation(_ mutation: Mutation) async throws
    func pendingMutations() async throws -> [Mutation]
    /// Drop journal entries with `mutationId <= upTo` for the client.
    func acknowledge(_ clientId: String, upTo: Int) async throws
    func nextMutationId(_ clientId: String) async throws -> Int

    // Sync bookkeeping
    func getCookie() async throws -> String?
    func setCookie(_ cookie: String) async throws
}

/// In-memory `ClientStore` for tests, SSR, and ephemeral clients. Insertion
/// order of confirmed rows is preserved (matching the Effect `Map`-based store),
/// which the reference subset evaluation relies on for unordered queries.
public actor InMemoryClientStore: ClientStore {
    private var rows: [String: OrderedRows] = [:]
    private var journal: [Mutation] = []
    private var counters: [String: Int] = [:]
    private var cookie: String?

    public init() {}

    public func getRow(_ collection: String, _ id: RowId) async throws -> StoredRow? {
        rows[collection]?.get(id)
    }

    public func listRows(_ collection: String) async throws -> [StoredRow] {
        rows[collection]?.values ?? []
    }

    public func putRow(_ collection: String, _ row: StoredRow) async throws {
        rows[collection, default: OrderedRows()].put(row)
    }

    public func delRow(_ collection: String, _ id: RowId) async throws {
        rows[collection]?.remove(id)
    }

    public func clearRows() async throws {
        rows.removeAll()
    }

    public func appendMutation(_ mutation: Mutation) async throws {
        journal.append(mutation)
    }

    public func pendingMutations() async throws -> [Mutation] {
        journal
    }

    public func acknowledge(_ clientId: String, upTo: Int) async throws {
        journal.removeAll { $0.clientId == clientId && $0.mutationId <= upTo }
    }

    public func nextMutationId(_ clientId: String) async throws -> Int {
        let next = (counters[clientId] ?? 0) + 1
        counters[clientId] = next
        return next
    }

    public func getCookie() async throws -> String? {
        cookie
    }

    public func setCookie(_ cookie: String) async throws {
        self.cookie = cookie
    }
}

/// An insertion-ordered row map keyed by id — the small ordered container the
/// stores and the engine's materialization use to preserve `Map` semantics.
struct OrderedRows {
    private var order: [RowId] = []
    private var map: [RowId: StoredRow] = [:]

    var values: [StoredRow] { order.compactMap { map[$0] } }

    func get(_ id: RowId) -> StoredRow? { map[id] }

    mutating func put(_ row: StoredRow) {
        if map[row.id] == nil { order.append(row.id) }
        map[row.id] = row
    }

    mutating func remove(_ id: RowId) {
        guard map[id] != nil else { return }
        map[id] = nil
        order.removeAll { $0 == id }
    }
}
