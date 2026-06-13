//
//  Subset.swift
//  EffectSync
//
//  A collection subset — `(collection, where, orderBy, limit, cursor)` — is the
//  subscription unit of the protocol (Subset.ts): the thing a client registers
//  with the server, the thing auth filters narrow, and the thing a CVR tracks.
//  Live queries reuse the same shape locally. This file also carries the
//  reference in-memory evaluation other backends must match.
//

import Foundation

/// Sort direction.
public enum Direction: String, Sendable, Hashable, Codable {
    case asc, desc
}

/// One sort term: a top-level row field plus direction.
public struct OrderBy: Sendable, Hashable, Codable {
    public let field: String
    public let direction: Direction

    public init(field: String, direction: Direction = .asc) {
        self.field = field
        self.direction = direction
    }
}

/// A collection subset. `limit` + `cursor` give cursor-based pagination.
public struct Subset: Sendable, Hashable, Codable {
    public let collection: String
    public let predicate: SyncPredicate
    public let orderBy: [OrderBy]
    public let limit: Int?
    public let cursor: String?

    private enum CodingKeys: String, CodingKey {
        case collection
        case predicate = "where"
        case orderBy
        case limit
        case cursor
    }

    public init(
        collection: String,
        where predicate: SyncPredicate = .always,
        orderBy: [OrderBy] = [],
        limit: Int? = nil,
        cursor: String? = nil
    ) {
        self.collection = collection
        self.predicate = predicate
        self.orderBy = orderBy
        self.limit = limit
        self.cursor = cursor
    }

    /// Stable identity for a subset, used as CVR / subscription / observer map
    /// keys (the Effect engine uses `JSON.stringify`; here it is canonical,
    /// sorted-key JSON so equal subsets always hash identically).
    public var identity: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self), let string = String(data: data, encoding: .utf8)
        else {
            return collection
        }
        return string
    }
}

// MARK: - Reference evaluation

extension Subset {
    private static func field(_ value: JSONValue, _ name: String) -> JSONValue {
        value[name] ?? .null
    }

    private static func compare(_ orderBy: [OrderBy], _ a: JSONValue, _ b: JSONValue) -> Int {
        for term in orderBy {
            let left = field(a, term.field)
            let right = field(b, term.field)
            if left == right { continue }
            if left.isNull { return term.direction == .asc ? -1 : 1 }
            if right.isNull { return term.direction == .asc ? 1 : -1 }
            let ordered = isLess(left, right) ? -1 : 1
            return term.direction == .asc ? ordered : -ordered
        }
        return 0
    }

    private static func isLess(_ left: JSONValue, _ right: JSONValue) -> Bool {
        if let l = left.numberValue, let r = right.numberValue { return l < r }
        if let l = left.stringValue, let r = right.stringValue { return l < r }
        return false
    }

    /// Reference in-memory evaluation of a subset over `(id, value)` rows:
    /// filter by predicate, sort, apply cursor (rows strictly after the row
    /// whose id equals the cursor), and limit. The memory backend, the client
    /// mirror, and any alternative backend must match these semantics.
    public static func apply<Row: RowLike>(_ rows: [Row], _ subset: Subset) -> [Row] {
        var result = rows.filter { subset.predicate.test($0.value) }
        if !subset.orderBy.isEmpty {
            // Stable sort (index tiebreaker) to match JS `toSorted`, which the
            // reference semantics rely on for deterministic ordering of equal
            // rows.
            result =
                result
                .enumerated()
                .sorted { lhs, rhs in
                    let ordered = compare(subset.orderBy, lhs.element.value, rhs.element.value)
                    return ordered != 0 ? ordered < 0 : lhs.offset < rhs.offset
                }
                .map(\.element)
        }
        if let cursor = subset.cursor {
            if let index = result.firstIndex(where: { $0.id == cursor }) {
                result = Array(result[(index + 1)...])
            }
        }
        if let limit = subset.limit {
            result = Array(result.prefix(limit))
        }
        return result
    }
}
