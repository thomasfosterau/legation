/*
 * SyncEngineTest.kt
 *
 * End-to-end engine tests mirroring `engine.test.ts`: optimistic write ->
 * journal -> push -> backend applies -> CVR diff -> pull patch -> rebase.
 */

package au.thomasfoster.effectsync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class SyncEngineTest {
    @Test
    fun optimisticWriteThenPushThenPullConfirmsAndDrainsJournal() = runTest {
        val server = TestServer()
        val (engine, store) = makeClient(server, "a")
        engine.subscribe(allTodos)

        engine.mutate(todoSet, Todo("1", "write tests", false))

        // Optimistic: visible locally before any network.
        val optimistic = engine.query(allTodos)
        assertEquals(listOf("1"), optimistic.map { it.id })

        engine.push()
        assertTrue(store.pendingMutations().isEmpty())

        engine.pull()
        val confirmed = store.listRows("todos")
        assertEquals(1, confirmed.size)
        assertEquals(RowVersion.of(1), confirmed.first().version)

        // Second pull: CVR makes the patch empty (cookie advanced, same rows).
        val before = store.getCookie()
        engine.pull()
        assertNotEquals(before, store.getCookie())
        assertEquals(1, store.listRows("todos").size)
    }

    @Test
    fun secondClientGroupPullsTheFirstGroupsCommittedWrites() = runTest {
        val server = TestServer()
        val (engineA) = makeClient(server, "a")
        val (engineB) = makeClient(server, "b")
        engineA.subscribe(allTodos)
        engineB.subscribe(allTodos)

        engineA.mutate(todoSet, Todo("1", "shared", false))
        engineA.push()

        engineB.pull()
        val seen = engineB.queryAs<Todo>(allTodos)
        assertEquals(listOf("shared"), seen.map { it.title })
    }

    @Test
    fun subscriptionsNarrowByPredicateAndDepartedRowsAreDeleted() = runTest {
        val server = TestServer()
        val (engine, store) = makeClient(server, "a")
        val openOnly = Subset(collection = "todos", where = Predicate.eq("done", JsonPrimitive(false)))
        engine.subscribe(openOnly)

        engine.mutate(todoSet, Todo("1", "open", false))
        engine.mutate(todoSet, Todo("2", "closed", true))
        engine.push()
        engine.pull()
        assertEquals(listOf("1"), store.listRows("todos").map { it.id })

        // Completing the open todo removes it from the subscribed subset.
        engine.mutate(todoSet, Todo("1", "open", true))
        engine.push()
        engine.pull()
        assertTrue(store.listRows("todos").isEmpty())
    }

    @Test
    fun rebaseKeepsPendingLocalMutationsVisibleOverPulledState() = runTest {
        val server = TestServer()
        val (engine, store) = makeClient(server, "a")
        engine.subscribe(allTodos)
        engine.mutate(todoSet, Todo("1", "v1", false))
        engine.push()

        // A second pending (unpushed) mutation must survive the pull (rebase).
        engine.mutate(todoSet, Todo("2", "pending", false))
        engine.pull()

        val view = engine.query(allTodos)
        assertEquals(listOf("1", "2"), view.map { it.id }.sorted())
        assertEquals(1, store.pendingMutations().size)
    }

    @Test
    fun unauthorizedCollectionsAreDeniedByDefault() = runTest {
        val server = TestServer()
        val (engine) = makeClient(server, "a")
        engine.subscribe(Subset(collection = "secrets"))
        assertFailsWith<SyncException.AuthorizationError> { engine.pull() }
    }

    @Test
    fun mutateEncodedRejectsArgsThatFailTheMutatorSchema() = runTest {
        val server = TestServer()
        val (engine, store) = makeClient(server, "a")
        // `id` should be a string and title/done are required; this fails decoding.
        assertFailsWith<SyncException.MutatorError> {
            engine.mutateEncoded("todo/set", buildJsonObject { put("id", 1) })
        }
        assertTrue(store.pendingMutations().isEmpty())
    }

    @Test
    fun rejectsUnknownMutators() = runTest {
        val server = TestServer()
        val (engine) = makeClient(server, "a")

        assertFailsWith<SyncException.MutatorError> {
            engine.mutateEncoded("todo/unknown", buildJsonObject { })
        }

        val ghost = mutator<Todo>("todo/ghost")
        assertFailsWith<SyncException.MutatorError> {
            engine.mutate(ghost, Todo("1", "x", false))
        }
    }

    @Test
    fun journalsEncodedArgsAndReplaysHandlersWithDecodedArgs() = runTest {
        val server = TestServer()
        val (engine, store) = makeClient(server, "a")
        engine.mutate(todoSet, Todo("1", "ship", false))

        // The journal holds the wire/persistence form.
        val pending = store.pendingMutations()
        assertEquals("ship", pending.first().args.jsonObject["title"]?.jsonPrimitive?.content)

        // Replay decoded the args back into a typed handler.
        val view = engine.queryAs<Todo>(allTodos)
        assertEquals(listOf(Todo("1", "ship", false)), view)
    }

    @Test
    fun observeEmitsInitialThenUpdatesOnChange() = runTest {
        val server = TestServer()
        val (engine) = makeClient(server, "a")
        engine.subscribe(allTodos)

        val channel = Channel<List<LocalRow>>(Channel.UNLIMITED)
        val collector = launch { engine.observe(allTodos).collect { channel.send(it) } }

        assertTrue(channel.receive().isEmpty())

        engine.mutate(todoSet, Todo("1", "observed", false))
        assertEquals(listOf("1"), channel.receive().map { it.id })

        collector.cancel()
    }
}
