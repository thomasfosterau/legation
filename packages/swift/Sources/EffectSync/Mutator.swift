//
//  Mutator.swift
//  EffectSync
//
//  A mutator is a named, schema-validated write intent defined once and
//  executed twice: optimistically on the client and authoritatively on the
//  backend (Mutator.ts, ADR-0008). Conflict resolution IS replay — the local
//  handler runs once optimistically and again on every rebase, so handlers must
//  be re-runnable.
//
//  The Effect version validates args with an `effect/Schema` codec; here the
//  args type is a `Codable` generic and `JSONValue` bridging is the codec.
//

import Foundation

/// A mutator definition: the shared, serializable contract. `Args` is the
/// decoded argument type.
public struct Mutator<Args: Codable & Sendable>: Sendable {
    public let name: String

    public init(_ name: String, args: Args.Type = Args.self) {
        self.name = name
    }
}

/// The local write surface handed to client-side mutator handlers. Writes apply
/// to the optimistic overlay only; authoritative versions arrive via patches.
public protocol LocalWriter: Sendable {
    /// Write a row's encoded value into the overlay.
    func put(_ collection: String, _ id: RowId, _ value: JSONValue) async throws
    func del(_ collection: String, _ id: RowId) async throws
    /// Read through confirmed rows + overlay (the current local view).
    func get(_ collection: String, _ id: RowId) async throws -> JSONValue?
}

extension LocalWriter {
    /// Write a typed row value, encoding it to its `JSONValue` form.
    public func put<Value: Encodable>(_ collection: String, _ id: RowId, _ value: Value)
        async throws
    {
        try await put(collection, id, JSONValue.encoding(value))
    }

    /// Read a row and decode it into a typed model, if present.
    public func get<Value: Decodable>(
        _ collection: String,
        _ id: RowId,
        as type: Value.Type
    ) async throws -> Value? {
        guard let value = try await get(collection, id) else { return nil }
        return try value.decoding(Value.self)
    }
}

/// A client-side handler for one mutator, in type-erased form: it decodes the
/// encoded args (validating them) and runs the typed handler.
struct MutatorEntry: Sendable {
    let name: String
    /// Decode args and run the handler against the writer.
    let run: @Sendable (JSONValue, any LocalWriter) async throws -> Void
    /// Validate encoded args by decoding them, without running anything.
    let validate: @Sendable (JSONValue) throws -> Void
}

/// A set of mutator definitions paired with their client-side handlers.
public struct MutatorRegistry: Sendable {
    var entries: [String: MutatorEntry] = [:]

    public init() {}

    /// Pair a mutator definition with its re-runnable local handler. Handlers
    /// receive decoded args; a duplicate name is a programmer error and traps.
    public mutating func register<Args: Codable & Sendable>(
        _ mutator: Mutator<Args>,
        _ handler: @escaping @Sendable (Args, any LocalWriter) async throws -> Void
    ) {
        precondition(entries[mutator.name] == nil, "Duplicate mutator name: \(mutator.name)")
        let name = mutator.name
        entries[name] = MutatorEntry(
            name: name,
            run: { encoded, writer in
                let args: Args
                do {
                    args = try encoded.decoding(Args.self)
                } catch {
                    throw SyncError.mutator(
                        "Invalid journaled args for mutator \"\(name)\"",
                        mutator: name
                    )
                }
                try await handler(args, writer)
            },
            validate: { encoded in
                do {
                    _ = try encoded.decoding(Args.self)
                } catch {
                    throw SyncError.mutator(
                        "Invalid args for mutator \"\(name)\"",
                        mutator: name
                    )
                }
            }
        )
    }

    /// Build a registry from a configuration closure.
    public static func make(_ build: (inout MutatorRegistry) -> Void) -> MutatorRegistry {
        var registry = MutatorRegistry()
        build(&registry)
        return registry
    }
}
