//
//  PredicateTests.swift
//  EffectSyncTests
//

import EffectSync
import XCTest

final class PredicateTests: XCTestCase {
    private func row(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

    func testComparisons() {
        let r = row(["n": .number(5), "s": .string("b")])
        XCTAssertTrue(SyncPredicate.eq("n", .number(5)).test(r))
        XCTAssertFalse(SyncPredicate.eq("n", .number(6)).test(r))
        XCTAssertTrue(SyncPredicate.ne("n", .number(6)).test(r))
        XCTAssertTrue(SyncPredicate.gt("n", .number(4)).test(r))
        XCTAssertTrue(SyncPredicate.gte("n", .number(5)).test(r))
        XCTAssertTrue(SyncPredicate.lt("n", .number(6)).test(r))
        XCTAssertTrue(SyncPredicate.lte("n", .number(5)).test(r))
        XCTAssertTrue(SyncPredicate.lt("s", .string("c")).test(r))
    }

    func testMixedTypeOrderedComparisonsAreFalse() {
        let r = row(["n": .number(5)])
        XCTAssertFalse(SyncPredicate.gt("n", .string("4")).test(r))
    }

    func testInAndBooleanCombinators() {
        let r = row(["status": .string("open"), "done": .bool(false)])
        XCTAssertTrue(SyncPredicate.isIn(field: "status", values: [.string("open"), .string("wip")]).test(r))
        XCTAssertFalse(SyncPredicate.isIn(field: "status", values: [.string("closed")]).test(r))

        let p = SyncPredicate.and([.eq("done", .bool(false)), .not(.eq("status", .string("closed")))])
        XCTAssertTrue(p.test(r))
        XCTAssertTrue(SyncPredicate.or([.eq("done", .bool(true)), .eq("status", .string("open"))]).test(r))
    }

    func testMissingFieldIsNull() {
        let r = row(["a": .number(1)])
        XCTAssertTrue(SyncPredicate.eq("missing", .null).test(r))
        XCTAssertFalse(SyncPredicate.eq("missing", .number(1)).test(r))
    }

    func testWireRoundTrip() throws {
        let original = SyncPredicate.and([
            .eq("done", .bool(false)),
            .isIn(field: "tag", values: [.string("x"), .string("y")]),
        ])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SyncPredicate.self, from: data)
        XCTAssertEqual(decoded, original)

        // The encoded form is the tagged-union wire shape.
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["_tag"] as? String, "And")
    }
}
