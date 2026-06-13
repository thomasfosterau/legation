//
//  SwiftDataClientStore.swift
//  EffectSyncData
//
//  The durable `ClientStore` (the Swift analogue of the browser package's
//  `IndexedDbClientStore`, ADR-0010). The Effect engine's durable store is
//  built over a key-value store — "one JSON blob per collection, plus
//  `collections`, `journal`, `counters`, and `cookie` keys" (ClientStore.ts) —
//  so a killed host rehydrates losslessly. Here SwiftData plays the role
//  IndexedDB plays in the browser: a single `@Model` key-value record table,
//  driven by a `@ModelActor` so reads-modify-writes are serialised the way the
//  Effect store's `Semaphore` serialises them.
//
//  This whole file compiles only where SwiftData is available; on other
//  platforms `EffectSyncData` is an empty module and apps use
//  `InMemoryClientStore` from `EffectSync`.
//

#if canImport(SwiftData)

    import EffectSync
    import Foundation
    import SwiftData

    /// One key→JSON-blob record. SwiftData is the key-value store the durable
    /// `ClientStore` layers over.
    @Model
    public final class SyncKeyValueRecord {
        @Attribute(.unique) public var key: String
        public var value: Data

        public init(key: String, value: Data) {
            self.key = key
            self.value = value
        }
    }

    /// A durable `ClientStore` over SwiftData. Every engine state transition
    /// lands in the model store, so a relaunched app rehydrates the journal,
    /// confirmed rows, and pull cookie.
    @ModelActor
    public actor SwiftDataClientStore: ClientStore {

        // MARK: Key-value plumbing

        private func record(_ key: String) throws -> SyncKeyValueRecord? {
            var descriptor = FetchDescriptor<SyncKeyValueRecord>(
                predicate: #Predicate { $0.key == key }
            )
            descriptor.fetchLimit = 1
            return try modelContext.fetch(descriptor).first
        }

        private func readData(_ key: String) throws -> Data? {
            try record(key)?.value
        }

        private func writeData(_ key: String, _ data: Data) throws {
            if let existing = try record(key) {
                existing.value = data
            } else {
                modelContext.insert(SyncKeyValueRecord(key: key, value: data))
            }
            try modelContext.save()
        }

        private func removeKey(_ key: String) throws {
            if let existing = try record(key) {
                modelContext.delete(existing)
                try modelContext.save()
            }
        }

        private func read<T: Decodable>(_ type: T.Type, _ key: String) throws -> T? {
            guard let data = try readData(key) else { return nil }
            return try JSONDecoder().decode(T.self, from: data)
        }

        private func write<T: Encodable>(_ key: String, _ value: T) throws {
            try writeData(key, try JSONEncoder().encode(value))
        }

        private func storeError(_ message: String) -> SyncError {
            .store(message)
        }

        // MARK: Key layout (mirrors ClientStore.ts `makeKeyValue`)

        private func rowsKey(_ collection: String) -> String { "rows/\(collection)" }

        private func rowMap(_ collection: String) throws -> [RowId: StoredRow] {
            (try read([RowId: StoredRow].self, rowsKey(collection))) ?? [:]
        }

        private func trackedCollections() throws -> [String] {
            (try read([String].self, "collections")) ?? []
        }

        private func trackCollection(_ collection: String) throws {
            var list = try trackedCollections()
            if !list.contains(collection) {
                list.append(collection)
                try write("collections", list)
            }
        }

        private func journalEntries() throws -> [Mutation] {
            (try read([Mutation].self, "journal")) ?? []
        }

        // MARK: ClientStore — confirmed rows

        public func getRow(_ collection: String, _ id: RowId) async throws -> StoredRow? {
            do { return try rowMap(collection)[id] } catch { throw storeError("Failed to read row") }
        }

        public func listRows(_ collection: String) async throws -> [StoredRow] {
            do {
                // Preserve insertion order via the `collections`-independent row
                // map's stable iteration is not guaranteed, so callers that need
                // ordering should rely on subset `orderBy`. The reference engine
                // keeps a dictionary here too.
                return Array(try rowMap(collection).values)
            } catch {
                throw storeError("Failed to list rows for \"\(collection)\"")
            }
        }

        public func putRow(_ collection: String, _ row: StoredRow) async throws {
            do {
                var map = try rowMap(collection)
                map[row.id] = row
                try write(rowsKey(collection), map)
                try trackCollection(collection)
            } catch {
                throw storeError("Failed to put row in \"\(collection)\"")
            }
        }

        public func delRow(_ collection: String, _ id: RowId) async throws {
            do {
                var map = try rowMap(collection)
                map[id] = nil
                try write(rowsKey(collection), map)
            } catch {
                throw storeError("Failed to delete row from \"\(collection)\"")
            }
        }

        public func clearRows() async throws {
            do {
                for collection in try trackedCollections() {
                    try removeKey(rowsKey(collection))
                }
                try write("collections", [String]())
            } catch {
                throw storeError("Failed to clear rows")
            }
        }

        // MARK: ClientStore — journal

        public func appendMutation(_ mutation: Mutation) async throws {
            do {
                var entries = try journalEntries()
                entries.append(mutation)
                try write("journal", entries)
            } catch {
                throw storeError("Failed to append mutation")
            }
        }

        public func pendingMutations() async throws -> [Mutation] {
            do { return try journalEntries() } catch { throw storeError("Failed to read journal") }
        }

        public func acknowledge(_ clientId: String, upTo: Int) async throws {
            do {
                let entries = try journalEntries().filter {
                    $0.clientId != clientId || $0.mutationId > upTo
                }
                try write("journal", entries)
            } catch {
                throw storeError("Failed to acknowledge mutations")
            }
        }

        public func nextMutationId(_ clientId: String) async throws -> Int {
            do {
                var counters = (try read([String: Int].self, "counters")) ?? [:]
                let next = (counters[clientId] ?? 0) + 1
                counters[clientId] = next
                try write("counters", counters)
                return next
            } catch {
                throw storeError("Failed to bump mutation id")
            }
        }

        // MARK: ClientStore — sync bookkeeping

        public func getCookie() async throws -> String? {
            do {
                guard let data = try readData("cookie") else { return nil }
                return String(data: data, encoding: .utf8)
            } catch {
                throw storeError("Failed to read cookie")
            }
        }

        public func setCookie(_ cookie: String) async throws {
            do {
                try writeData("cookie", Data(cookie.utf8))
            } catch {
                throw storeError("Failed to write cookie")
            }
        }
    }

    extension SwiftDataClientStore {
        /// Build a store backed by a fresh `ModelContainer` for the key-value
        /// record. Pass `inMemory: true` for tests and ephemeral clients.
        public static func make(inMemory: Bool = false) throws -> SwiftDataClientStore {
            let configuration = ModelConfiguration(isStoredInMemoryOnly: inMemory)
            let container = try ModelContainer(
                for: SyncKeyValueRecord.self,
                configurations: configuration
            )
            return SwiftDataClientStore(modelContainer: container)
        }
    }

#endif
