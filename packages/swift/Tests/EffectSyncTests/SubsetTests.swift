//
//  SubsetTests.swift
//  EffectSyncTests
//

import EffectSync
import XCTest

final class SubsetTests: XCTestCase {
    private func rows() -> [LocalRow] {
        [
            LocalRow(id: "1", value: .object(["n": .number(3), "done": .bool(false)])),
            LocalRow(id: "2", value: .object(["n": .number(1), "done": .bool(true)])),
            LocalRow(id: "3", value: .object(["n": .number(2), "done": .bool(false)])),
        ]
    }

    func testFilter() {
        let subset = Subset(collection: "todos", where: .eq("done", .bool(false)))
        XCTAssertEqual(Subset.apply(rows(), subset).map(\.id), ["1", "3"])
    }

    func testOrderByAscendingAndDescending() {
        let asc = Subset(collection: "todos", orderBy: [OrderBy(field: "n", direction: .asc)])
        XCTAssertEqual(Subset.apply(rows(), asc).map(\.id), ["2", "3", "1"])

        let desc = Subset(collection: "todos", orderBy: [OrderBy(field: "n", direction: .desc)])
        XCTAssertEqual(Subset.apply(rows(), desc).map(\.id), ["1", "3", "2"])
    }

    func testCursorAndLimit() {
        let ordered = Subset(collection: "todos", orderBy: [OrderBy(field: "n", direction: .asc)])
        // Ordered ids: 2, 3, 1 — cursor "3" yields rows strictly after it.
        let afterCursor = Subset(
            collection: "todos",
            orderBy: [OrderBy(field: "n", direction: .asc)],
            cursor: "3"
        )
        XCTAssertEqual(Subset.apply(rows(), afterCursor).map(\.id), ["1"])

        let limited = Subset(
            collection: "todos",
            orderBy: ordered.orderBy,
            limit: 2
        )
        XCTAssertEqual(Subset.apply(rows(), limited).map(\.id), ["2", "3"])
    }

    func testIdentityIsStableAndOrderIndependentForEqualSubsets() {
        let a = Subset(collection: "todos", where: .eq("done", .bool(false)))
        let b = Subset(collection: "todos", where: .eq("done", .bool(false)))
        XCTAssertEqual(a.identity, b.identity)

        let c = Subset(collection: "todos", where: .eq("done", .bool(true)))
        XCTAssertNotEqual(a.identity, c.identity)
    }

    func testWireRoundTripUsesWhereKey() throws {
        let subset = Subset(
            collection: "todos",
            where: .eq("done", .bool(false)),
            orderBy: [OrderBy(field: "n", direction: .asc)],
            limit: 10
        )
        let data = try JSONEncoder().encode(subset)
        let decoded = try JSONDecoder().decode(Subset.self, from: data)
        XCTAssertEqual(decoded, subset)

        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(json["where"], "subset encodes its predicate under the `where` key")
    }
}
