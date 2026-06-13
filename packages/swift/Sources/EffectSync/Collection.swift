//
//  Collection.swift
//  EffectSync
//
//  A collection is a named, schema-typed set of rows keyed by row id — the
//  unit the client materializes locally and queries (CONTEXT.md, Collection.ts).
//  The Effect definition carries an `effect/Schema` codec; the Swift definition
//  carries the row type as a `Codable` generic parameter, with `JSONValue`
//  bridging providing the encode/decode the schema provides there.
//
//  Naming note: the type is `SyncCollection`, not `Collection`, to avoid
//  shadowing the Swift standard library's `Collection` protocol.
//

import Foundation

/// The identifier of one row within a collection.
public typealias RowId = String

/// An opaque per-row token the backend changes on every authoritative write —
/// the basis for CVR diffing (ADR-0008). The wire form is `string | number`.
public enum RowVersion: Sendable, Hashable, Codable {
    case string(String)
    case number(Double)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        }
    }
}

extension RowVersion: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

/// Anything addressable as `(id, encoded value)` — the shape subset evaluation
/// and predicates operate over.
public protocol RowLike {
    var id: RowId { get }
    var value: JSONValue { get }
}

/// A confirmed row as persisted: encoded value plus authoritative version.
public struct StoredRow: Sendable, Hashable, Codable, RowLike {
    public let id: RowId
    public let version: RowVersion
    public let value: JSONValue

    public init(id: RowId, version: RowVersion, value: JSONValue) {
        self.id = id
        self.version = version
        self.value = value
    }
}

/// A locally-materialized row: confirmed rows with the optimistic overlay
/// replayed on top carry no version yet, so only `(id, value)` is exposed.
public struct LocalRow: Sendable, Hashable, RowLike {
    public let id: RowId
    public let value: JSONValue

    public init(id: RowId, value: JSONValue) {
        self.id = id
        self.value = value
    }

    /// Decode the row's encoded value into a typed model.
    public func decoding<Value: Decodable>(_ type: Value.Type = Value.self) throws -> Value {
        try value.decoding(Value.self)
    }
}

/// A collection definition. `Value` is the decoded row type; rows cross the
/// engine boundary in their `JSONValue` encoded form.
public struct SyncCollection<Value: Codable & Sendable>: Sendable {
    public let name: String
    /// Derive the row id from a decoded row value.
    public let id: @Sendable (Value) -> RowId

    public init(name: String, id: @escaping @Sendable (Value) -> RowId) {
        self.name = name
        self.id = id
    }
}

extension SyncCollection where Value: Identifiable, Value.ID == RowId {
    /// Define a collection whose row type is `Identifiable` by `RowId`.
    public init(name: String) {
        self.init(name: name, id: { $0.id })
    }
}
