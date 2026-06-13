//
//  Predicate.swift
//  EffectSync
//
//  The serializable expression language over row fields used by subscriptions
//  and live queries (Predicate.ts). Predicates are data — an expression tree —
//  not opaque closures, so they travel over the wire, get narrowed by
//  server-side auth filters, and evaluate against any storage. Core ships an
//  in-memory evaluator; this is its Swift twin.
//
//  Naming note: the type is `SyncPredicate`, not `Predicate`, to avoid
//  shadowing Foundation's `Predicate`.
//

import Foundation

/// Comparison operators over a row field.
public enum Comparison: String, Sendable, Hashable, Codable {
    case eq, ne, gt, gte, lt, lte
}

/// A predicate expression tree. Literals are modelled as scalar `JSONValue`s
/// (string, number, bool, null).
public indirect enum SyncPredicate: Sendable, Hashable {
    /// Matches every row (the empty predicate).
    case always
    /// Compares a top-level row field against a literal.
    case compare(op: Comparison, field: String, value: JSONValue)
    /// Tests field membership in a literal set.
    case isIn(field: String, values: [JSONValue])
    case and([SyncPredicate])
    case or([SyncPredicate])
    case not(SyncPredicate)
}

// MARK: - Constructors

extension SyncPredicate {
    public static func eq(_ field: String, _ value: JSONValue) -> SyncPredicate {
        .compare(op: .eq, field: field, value: value)
    }
    public static func ne(_ field: String, _ value: JSONValue) -> SyncPredicate {
        .compare(op: .ne, field: field, value: value)
    }
    public static func gt(_ field: String, _ value: JSONValue) -> SyncPredicate {
        .compare(op: .gt, field: field, value: value)
    }
    public static func gte(_ field: String, _ value: JSONValue) -> SyncPredicate {
        .compare(op: .gte, field: field, value: value)
    }
    public static func lt(_ field: String, _ value: JSONValue) -> SyncPredicate {
        .compare(op: .lt, field: field, value: value)
    }
    public static func lte(_ field: String, _ value: JSONValue) -> SyncPredicate {
        .compare(op: .lte, field: field, value: value)
    }
}

// MARK: - Evaluation

extension SyncPredicate {
    private static func field(_ row: JSONValue, _ name: String) -> JSONValue {
        row[name] ?? .null
    }

    private static func compareValues(_ op: Comparison, _ left: JSONValue, _ right: JSONValue)
        -> Bool
    {
        switch op {
        case .eq: return left == right
        case .ne: return left != right
        case .gt, .gte, .lt, .lte:
            if let l = left.numberValue, let r = right.numberValue {
                return ordered(op, l, r)
            }
            if let l = left.stringValue, let r = right.stringValue {
                return ordered(op, l, r)
            }
            return false
        }
    }

    private static func ordered<T: Comparable>(_ op: Comparison, _ left: T, _ right: T) -> Bool {
        switch op {
        case .gt: return left > right
        case .gte: return left >= right
        case .lt: return left < right
        case .lte: return left <= right
        case .eq, .ne: return false
        }
    }

    /// Evaluate this predicate against an encoded row value (in-memory
    /// semantics: top-level field access, strict equality, ordered comparisons
    /// on same-typed string/number pairs only).
    public func test(_ row: JSONValue) -> Bool {
        switch self {
        case .always:
            return true
        case let .compare(op, field, value):
            return Self.compareValues(op, Self.field(row, field), value)
        case let .isIn(field, values):
            return values.contains(Self.field(row, field))
        case let .and(predicates):
            return predicates.allSatisfy { $0.test(row) }
        case let .or(predicates):
            return predicates.contains { $0.test(row) }
        case let .not(predicate):
            return !predicate.test(row)
        }
    }
}

// MARK: - Codable (tagged-union wire form matching PredicateSchema)

extension SyncPredicate: Codable {
    private enum CodingKeys: String, CodingKey {
        case tag = "_tag"
        case op, field, value, values, predicates, predicate
    }

    private enum Tag: String, Codable {
        case always = "True"
        case compare = "Compare"
        case isIn = "In"
        case and = "And"
        case or = "Or"
        case not = "Not"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Tag.self, forKey: .tag) {
        case .always:
            self = .always
        case .compare:
            self = .compare(
                op: try container.decode(Comparison.self, forKey: .op),
                field: try container.decode(String.self, forKey: .field),
                value: try container.decode(JSONValue.self, forKey: .value)
            )
        case .isIn:
            self = .isIn(
                field: try container.decode(String.self, forKey: .field),
                values: try container.decode([JSONValue].self, forKey: .values)
            )
        case .and:
            self = .and(try container.decode([SyncPredicate].self, forKey: .predicates))
        case .or:
            self = .or(try container.decode([SyncPredicate].self, forKey: .predicates))
        case .not:
            self = .not(try container.decode(SyncPredicate.self, forKey: .predicate))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .always:
            try container.encode(Tag.always, forKey: .tag)
        case let .compare(op, field, value):
            try container.encode(Tag.compare, forKey: .tag)
            try container.encode(op, forKey: .op)
            try container.encode(field, forKey: .field)
            try container.encode(value, forKey: .value)
        case let .isIn(field, values):
            try container.encode(Tag.isIn, forKey: .tag)
            try container.encode(field, forKey: .field)
            try container.encode(values, forKey: .values)
        case let .and(predicates):
            try container.encode(Tag.and, forKey: .tag)
            try container.encode(predicates, forKey: .predicates)
        case let .or(predicates):
            try container.encode(Tag.or, forKey: .tag)
            try container.encode(predicates, forKey: .predicates)
        case let .not(predicate):
            try container.encode(Tag.not, forKey: .tag)
            try container.encode(predicate, forKey: .predicate)
        }
    }
}
