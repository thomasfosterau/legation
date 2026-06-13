//
//  WireFormatTests.swift
//  EffectSyncTests
//
//  The protocol values are the carrier-agnostic wire form; these tests pin the
//  encoded shapes (tags, keys) and the typed <-> JSONValue bridging the engine
//  relies on for validation.
//

import EffectSync
import XCTest

final class WireFormatTests: XCTestCase {
    func testJSONValueRoundTrip() throws {
        let value: JSONValue = .object([
            "id": .string("1"),
            "n": .number(2),
            "flag": .bool(true),
            "nested": .array([.null, .string("x")]),
        ])
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, value)
    }

    func testTypedBridging() throws {
        struct Sample: Codable, Equatable { let id: String; let n: Int }
        let encoded = try JSONValue.encoding(Sample(id: "1", n: 7))
        XCTAssertEqual(encoded["id"]?.stringValue, "1")
        XCTAssertEqual(encoded["n"]?.numberValue, 7)
        let decoded: Sample = try encoded.decoding()
        XCTAssertEqual(decoded, Sample(id: "1", n: 7))
    }

    func testPatchOpTaggedUnion() throws {
        let put = PatchOp.put(collection: "todos", id: "1", version: .number(3), value: .string("v"))
        let data = try JSONEncoder().encode(put)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["_tag"] as? String, "Put")
        XCTAssertEqual(try JSONDecoder().decode(PatchOp.self, from: data), put)

        let clear = PatchOp.clear
        let clearData = try JSONEncoder().encode(clear)
        XCTAssertEqual(try JSONDecoder().decode(PatchOp.self, from: clearData), clear)
    }

    func testRowVersionEncodesAsBareScalar() throws {
        XCTAssertEqual(try JSONDecoder().decode(RowVersion.self, from: Data("5".utf8)), .number(5))
        XCTAssertEqual(
            try JSONDecoder().decode(RowVersion.self, from: Data("\"abc\"".utf8)),
            .string("abc")
        )
    }

    func testPullRequestOmitsAbsentCookie() throws {
        let request = PullRequest(clientGroupId: "g", cookie: nil, subscriptions: [])
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["cookie"], "absent cookie is omitted from the wire form")
    }
}
