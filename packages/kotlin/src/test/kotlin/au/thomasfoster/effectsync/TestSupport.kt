/*
 * TestSupport.kt
 *
 * A minimal authoritative backend and loopback transport, enough to drive the
 * client engine end to end: client mutates optimistically -> journal -> push ->
 * backend applies authoritatively -> CVR diff -> pull patch -> rebase. This is
 * the Kotlin counterpart of the MemoryBackend + SyncServer + in-memory transport
 * the Effect `engine.test.ts` wires up.
 */

package au.thomasfoster.effectsync

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// ─── Fixtures ────────────────────────────────────────────────────────────────

@Serializable
data class Todo(val id: String, val title: String, val done: Boolean)

@Serializable
data class RemoveArgs(val id: String)

val todoSet = mutator<Todo>("todo/set")
val todoRemove = mutator<RemoveArgs>("todo/remove")
val allTodos = Subset(collection = "todos")

/** A fresh client-side mutator registry per call (duplicate names would throw). */
fun makeRegistry(): MutatorRegistry = mutatorRegistry {
    register(todoSet) { todo, writer -> writer.put("todos", todo.id, todo) }
    register(todoRemove) { args, writer -> writer.del("todos", args.id) }
}

// ─── Backend ─────────────────────────────────────────────────────────────────

class AuthRow(val version: Int, val value: JsonElement)

/** The authoritative write surface; `put` bumps the global version counter. */
class BackendWriter(
    val rows: MutableMap<String, LinkedHashMap<RowId, AuthRow>>,
    var counter: Int,
) {
    fun put(collection: String, id: RowId, value: JsonElement) {
        counter += 1
        rows.getOrPut(collection) { LinkedHashMap() }[id] = AuthRow(counter, value)
    }

    fun del(collection: String, id: RowId) {
        rows[collection]?.remove(id)
    }
}

private fun JsonElement.idField(): String? = jsonObject["id"]?.jsonPrimitive?.content

val backendHandlers: Map<String, (JsonElement, BackendWriter) -> Unit> = mapOf(
    "todo/set" to { args, writer -> args.idField()?.let { writer.put("todos", it, args) } },
    "todo/remove" to { args, writer -> args.idField()?.let { writer.del("todos", it) } },
)

/**
 * A tiny authoritative server with exactly-once mutation application and a
 * cookie-keyed CVR that computes minimal pull patches.
 */
class TestServer(
    private val allowed: Set<String> = setOf("todos"),
    private val handlers: Map<String, (JsonElement, BackendWriter) -> Unit> = backendHandlers,
) {
    private data class RowKey(val collection: String, val id: String)
    private class Desired(val version: Int, val value: JsonElement)

    private val mutex = Mutex()
    private val rows = mutableMapOf<String, LinkedHashMap<RowId, AuthRow>>()
    private var versionCounter = 0
    private val applied = mutableMapOf<String, Int>()
    private val cvrByCookie = mutableMapOf<String, Map<RowKey, Int>>()
    private var cookieCounter = 0

    suspend fun handlePush(request: PushRequest): PushResponse = mutex.withLock {
        val writer = BackendWriter(rows, versionCounter)
        for (mutation in request.mutations) {
            val last = applied[mutation.clientId]
            if (last != null && mutation.mutationId <= last) continue
            handlers[mutation.mutator]?.invoke(mutation.args, writer)
            applied[mutation.clientId] = mutation.mutationId
        }
        versionCounter = writer.counter
        PushResponse(applied.toMap())
    }

    suspend fun handlePull(request: PullRequest): PullResponse = mutex.withLock {
        for (subset in request.subscriptions) {
            if (subset.collection !in allowed) {
                throw SyncException.AuthorizationError(
                    "Collection not allowed: ${subset.collection}",
                    subset.collection,
                )
            }
        }

        val desired = mutableMapOf<RowKey, Desired>()
        for (subset in request.subscriptions) {
            val collectionRows = rows[subset.collection] ?: emptyMap()
            val localRows = collectionRows.map { LocalRow(it.key, it.value.value) }
            for (row in Subset.apply(localRows, subset)) {
                val version = collectionRows.getValue(row.id).version
                desired[RowKey(subset.collection, row.id)] = Desired(version, row.value)
            }
        }

        val previous = request.cookie?.let { cvrByCookie[it] } ?: emptyMap()
        val patch = mutableListOf<PatchOp>()
        for ((key, entry) in desired) {
            if (previous[key] != entry.version) {
                patch.add(PatchOp.Put(key.collection, key.id, RowVersion.of(entry.version), entry.value))
            }
        }
        for ((key, _) in previous) {
            if (key !in desired) patch.add(PatchOp.Del(key.collection, key.id))
        }

        cookieCounter += 1
        val cookie = cookieCounter.toString()
        cvrByCookie[cookie] = desired.mapValues { it.value.version }
        PullResponse(cookie, patch, applied.toMap())
    }
}

// ─── Transport ────────────────────────────────────────────────────────────────

/** An in-memory `ClientTransport` bound directly to a `TestServer`. */
class LoopbackTransport(
    private val server: TestServer,
    private val clientGroupId: String,
) : ClientTransport {
    override suspend fun push(request: PushRequest): PushResponse = server.handlePush(request)
    override suspend fun pull(request: PullRequest): PullResponse = server.handlePull(request)
    override fun pokes(): Flow<Poke> = emptyFlow()
    override suspend fun status(): ConnectionStatus = ConnectionStatus.CONNECTED
    override fun statusChanges(): Flow<ConnectionStatus> = flowOf(ConnectionStatus.CONNECTED)
}

// ─── Client wiring ─────────────────────────────────────────────────────────────

fun makeClient(server: TestServer, name: String): Pair<SyncEngine, InMemoryClientStore> {
    val store = InMemoryClientStore()
    val transport = LoopbackTransport(server, "group-$name")
    val engine = SyncEngine(
        clientId = "client-$name",
        clientGroupId = "group-$name",
        mutators = makeRegistry(),
        store = store,
        transport = transport,
    )
    return engine to store
}
