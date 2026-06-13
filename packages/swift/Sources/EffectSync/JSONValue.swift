//
//  JSONValue.swift
//  EffectSync
//
//  The engine moves rows and mutator args around in their *encoded*
//  (wire/persistence) form. In the Effect implementation that form is
//  TypeScript's `unknown` — arbitrary JSON validated by an `effect/Schema`
//  codec. Swift has no `unknown`, so the encoded form is modelled explicitly
//  as `JSONValue`, and `Codable` plays the role the schema codec plays: typed
//  values cross into the engine by encoding to `JSONValue` and come back out
//  by decoding from it. A decode failure is exactly the validation failure the
//  schema would raise.
//

import Foundation

/// A self-describing JSON value: the engine's universal encoded form.
public enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

// MARK: - Codable

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

// MARK: - Bridging to and from typed `Codable` values

extension JSONValue {
    /// Encode any `Encodable` value to its `JSONValue` form. Throws if the
    /// value cannot be represented as JSON — the encoding-side validation the
    /// engine performs at a mutator's call site.
    public static func encoding<Value: Encodable>(_ value: Value) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Decode this value into a typed `Decodable`. Throws if the shape does not
    /// match — the decoding-side validation the engine performs on replay and
    /// when receiving encoded args over a carrier.
    public func decoding<Value: Decodable>(_ type: Value.Type = Value.self) throws -> Value {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(Value.self, from: data)
    }
}

// MARK: - Convenience accessors

extension JSONValue {
    public var objectValue: [String: JSONValue]? {
        if case let .object(value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// Read a top-level field of an object value.
    public subscript(_ key: String) -> JSONValue? {
        objectValue?[key]
    }
}
