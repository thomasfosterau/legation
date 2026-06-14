package au.thomasfoster.effectsync.example

import au.thomasfoster.effectsync.ClientTransport
import au.thomasfoster.effectsync.ConnectionStatus
import au.thomasfoster.effectsync.InMemoryClientStore
import au.thomasfoster.effectsync.LocalRow
import au.thomasfoster.effectsync.PatchOp
import au.thomasfoster.effectsync.Poke
import au.thomasfoster.effectsync.PullRequest
import au.thomasfoster.effectsync.PullResponse
import au.thomasfoster.effectsync.PushRequest
import au.thomasfoster.effectsync.PushResponse
import au.thomasfoster.effectsync.RowId
import au.thomasfoster.effectsync.RowVersion
import au.thomasfoster.effectsync.Subset
import au.thomasfoster.effectsync.SyncEngine
import au.thomasfoster.effectsync.mutatorRegistry
import au.thomasfoster.effectsync.put
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * A tiny in-process authoritative backend so the example actually syncs: it
 * applies pushed mutations, bumps a row version on every write, and computes a
 * minimal pull patch against a cookie-keyed view record (the same CVR diff the
 * real server performs). This is the demo equivalent of effect-sync-core's
 * MemoryBackend + SyncServer.
 */
class DemoServer {
    private class Row(val version: Int, val value: JsonElement)
    private data class RowKey(val collection: String, val id: String)

    private val mutex = Mutex()
    private val rows = mutableMapOf<String, LinkedHashMap<RowId, Row>>()
    private var versionCounter = 0
    private val applied = mutableMapOf<String, Int>()
    private val cvrByCookie = mutableMapOf<String, Map<RowKey, Int>>()
    private var cookieCounter = 0

    private fun JsonElement.id(): String? = jsonObject["id"]?.jsonPrimitive?.content

    suspend fun handlePush(request: PushRequest): PushResponse = mutex.withLock {
        for (mutation in request.mutations) {
            val last = applied[mutation.clientId]
            if (last != null && mutation.mutationId <= last) continue
            val id = mutation.args.id()
            if (id != null) {
                when (mutation.mutator) {
                    "todo/set" -> {
                        versionCounter += 1
                        rows.getOrPut("todos") { LinkedHashMap() }[id] = Row(versionCounter, mutation.args)
                    }
                    "todo/remove" -> rows["todos"]?.remove(id)
                }
            }
            applied[mutation.clientId] = mutation.mutationId
        }
        PushResponse(applied.toMap())
    }

    suspend fun handlePull(request: PullRequest): PullResponse = mutex.withLock {
        val desired = mutableMapOf<RowKey, Pair<Int, JsonElement>>()
        for (subset in request.subscriptions) {
            val collectionRows = rows[subset.collection] ?: emptyMap()
            val localRows = collectionRows.map { LocalRow(it.key, it.value.value) }
            for (row in Subset.apply(localRows, subset)) {
                val version = collectionRows.getValue(row.id).version
                desired[RowKey(subset.collection, row.id)] = version to row.value
            }
        }

        val previous = request.cookie?.let { cvrByCookie[it] } ?: emptyMap()
        val patch = mutableListOf<PatchOp>()
        for ((key, entry) in desired) {
            if (previous[key] != entry.first) {
                patch.add(PatchOp.Put(key.collection, key.id, RowVersion.of(entry.first), entry.second))
            }
        }
        for ((key, _) in previous) {
            if (key !in desired) patch.add(PatchOp.Del(key.collection, key.id))
        }

        cookieCounter += 1
        val cookie = cookieCounter.toString()
        cvrByCookie[cookie] = desired.mapValues { it.value.first }
        PullResponse(cookie, patch, applied.toMap())
    }
}

/** An in-memory transport bound straight to a [DemoServer]. */
class LoopbackTransport(private val server: DemoServer) : ClientTransport {
    override suspend fun push(request: PushRequest): PushResponse = server.handlePush(request)
    override suspend fun pull(request: PullRequest): PullResponse = server.handlePull(request)
    override fun pokes(): Flow<Poke> = emptyFlow()
    override suspend fun status(): ConnectionStatus = ConnectionStatus.CONNECTED
    override fun statusChanges(): Flow<ConnectionStatus> = flowOf(ConnectionStatus.CONNECTED)
}

/** Wire up an engine over an in-memory store and the loopback demo backend. */
fun buildDemoEngine(clientId: String = "compose-demo"): SyncEngine {
    val registry = mutatorRegistry {
        register(setTodo) { todo, writer -> writer.put("todos", todo.id, todo) }
        register(removeTodo) { args, writer -> writer.del("todos", args.id) }
    }
    return SyncEngine(
        clientId = clientId,
        clientGroupId = "group-demo",
        mutators = registry,
        store = InMemoryClientStore(),
        transport = LoopbackTransport(DemoServer()),
    )
}
