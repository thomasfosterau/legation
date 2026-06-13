//
//  SyncEngineTests.swift
//  EffectSyncTests
//
//  End-to-end engine tests mirroring `engine.test.ts`: optimistic write →
//  journal → push → backend applies → CVR diff → pull patch → rebase.
//

import EffectSync
import XCTest

final class SyncEngineTests: XCTestCase {
    func testOptimisticWriteThenPushThenPullConfirmsAndDrainsJournal() async throws {
        let server = TestServer()
        let (engine, store) = makeClient(server, "a")
        await engine.subscribe(allTodos)

        try await engine.mutate(todoSet, Todo("1", "write tests", false))

        // Optimistic: visible locally before any network.
        let optimistic = try await engine.query(allTodos)
        XCTAssertEqual(optimistic.map(\.id), ["1"])

        try await engine.push()
        let pending = try await store.pendingMutations()
        XCTAssertTrue(pending.isEmpty)

        try await engine.pull()
        let confirmed = try await store.listRows("todos")
        XCTAssertEqual(confirmed.count, 1)
        XCTAssertEqual(confirmed.first?.version, 1)

        // Second pull: CVR makes the patch empty (cookie advanced, same rows).
        let before = try await store.getCookie()
        try await engine.pull()
        let after = try await store.getCookie()
        XCTAssertNotEqual(after, before)
        XCTAssertEqual(try await store.listRows("todos").count, 1)
    }

    func testSecondClientGroupPullsTheFirstGroupsCommittedWrites() async throws {
        let server = TestServer()
        let a = makeClient(server, "a")
        let b = makeClient(server, "b")
        await a.engine.subscribe(allTodos)
        await b.engine.subscribe(allTodos)

        try await a.engine.mutate(todoSet, Todo("1", "shared", false))
        try await a.engine.push()

        try await b.engine.pull()
        let seen = try await b.engine.query(allTodos, as: Todo.self)
        XCTAssertEqual(seen.map(\.title), ["shared"])
    }

    func testSubscriptionsNarrowByPredicateAndDepartedRowsAreDeleted() async throws {
        let server = TestServer()
        let (engine, store) = makeClient(server, "a")
        let openOnly = Subset(collection: "todos", where: .eq("done", .bool(false)))
        await engine.subscribe(openOnly)

        try await engine.mutate(todoSet, Todo("1", "open", false))
        try await engine.mutate(todoSet, Todo("2", "closed", true))
        try await engine.push()
        try await engine.pull()
        XCTAssertEqual((try await store.listRows("todos")).map(\.id), ["1"])

        // Completing the open todo removes it from the subscribed subset.
        try await engine.mutate(todoSet, Todo("1", "open", true))
        try await engine.push()
        try await engine.pull()
        XCTAssertTrue((try await store.listRows("todos")).isEmpty)
    }

    func testRebaseKeepsPendingLocalMutationsVisibleOverPulledState() async throws {
        let server = TestServer()
        let a = makeClient(server, "a")
        await a.engine.subscribe(allTodos)
        try await a.engine.mutate(todoSet, Todo("1", "v1", false))
        try await a.engine.push()

        // A second pending (unpushed) mutation must survive the pull (rebase).
        try await a.engine.mutate(todoSet, Todo("2", "pending", false))
        try await a.engine.pull()

        let view = try await a.engine.query(allTodos)
        XCTAssertEqual(view.map(\.id).sorted(), ["1", "2"])
        XCTAssertEqual((try await a.store.pendingMutations()).count, 1)
    }

    func testUnauthorizedCollectionsAreDeniedByDefault() async throws {
        let server = TestServer()
        let (engine, _) = makeClient(server, "a")
        await engine.subscribe(Subset(collection: "secrets"))
        do {
            try await engine.pull()
            XCTFail("Expected an authorization failure")
        } catch let error as SyncError {
            XCTAssertEqual(error.tag, "AuthorizationError")
        }
    }

    // MARK: Mutator validation

    func testMutateEncodedRejectsArgsThatFailTheMutatorSchema() async throws {
        let server = TestServer()
        let (engine, store) = makeClient(server, "a")
        do {
            // `id` should be a string; a number fails decoding into `Todo`.
            try await engine.mutateEncoded("todo/set", .object(["id": .number(1)]))
            XCTFail("Expected a mutator validation failure")
        } catch let error as SyncError {
            XCTAssertEqual(error.tag, "MutatorError")
        }
        XCTAssertTrue((try await store.pendingMutations()).isEmpty)
    }

    func testRejectsUnknownMutators() async throws {
        let server = TestServer()
        let (engine, _) = makeClient(server, "a")

        do {
            try await engine.mutateEncoded("todo/unknown", .object([:]))
            XCTFail("Expected a mutator failure")
        } catch let error as SyncError {
            XCTAssertEqual(error.tag, "MutatorError")
        }

        let ghost = Mutator<Todo>("todo/ghost")
        do {
            try await engine.mutate(ghost, Todo("1", "x", false))
            XCTFail("Expected a mutator failure")
        } catch let error as SyncError {
            XCTAssertEqual(error.tag, "MutatorError")
        }
    }

    func testJournalsEncodedArgsAndReplaysHandlersWithDecodedArgs() async throws {
        let server = TestServer()
        let (engine, store) = makeClient(server, "a")
        try await engine.mutate(todoSet, Todo("1", "ship", false))

        // The journal holds the wire/persistence form.
        let pending = try await store.pendingMutations()
        XCTAssertEqual(pending.first?.args["title"]?.stringValue, "ship")

        // Replay decoded the args back into a typed handler.
        let view = try await engine.query(allTodos, as: Todo.self)
        XCTAssertEqual(view, [Todo("1", "ship", false)])
    }

    // MARK: Observation

    func testObserveEmitsInitialThenUpdatesOnChange() async throws {
        let server = TestServer()
        let (engine, _) = makeClient(server, "a")
        await engine.subscribe(allTodos)

        var iterator = engine.observe(allTodos).makeAsyncIterator()

        let initial = await iterator.next()
        XCTAssertEqual(initial?.isEmpty, true)

        try await engine.mutate(todoSet, Todo("1", "observed", false))
        let updated = await iterator.next()
        XCTAssertEqual(updated?.map(\.id), ["1"])
    }
}
