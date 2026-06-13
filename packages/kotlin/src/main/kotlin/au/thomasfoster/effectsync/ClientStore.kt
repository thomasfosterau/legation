/*
 * ClientStore.kt
 *
 * The client's durable state: confirmed rows per collection, the journal of
 * pending mutations, the per-client mutation-id counters, and the pull cookie
 * (ClientStore.ts). Every engine state transition is persisted here so a killed
 * host rehydrates losslessly. Rows stored here are *confirmed* state only;
 * optimistic effects live in the overlay and are recomputed by replay.
 *
 * This file ships the in-memory implementation plus a `KeyValueStore`-backed one
 * that mirrors core's durable store ("one JSON blob per collection, plus
 * `collections`, `journal`, `counters`, and `cookie` keys"). On Android or
 * Kotlin Multiplatform, back the `KeyValueStore` seam with Room/DataStore or
 * SQLDelight — the engine never changes.
 */

package au.thomasfoster.effectsync

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/** The client's durable store. Suspending throughout — a real store hits disk. */
interface ClientStore {
    // Confirmed rows
    suspend fun getRow(collection: String, id: RowId): StoredRow?
    suspend fun listRows(collection: String): List<StoredRow>
    suspend fun putRow(collection: String, row: StoredRow)
    suspend fun delRow(collection: String, id: RowId)
    suspend fun clearRows()

    // Journal
    suspend fun appendMutation(mutation: Mutation)
    suspend fun pendingMutations(): List<Mutation>
    /** Drop journal entries with `mutationId <= upTo` for the client. */
    suspend fun acknowledge(clientId: String, upTo: Int)
    suspend fun nextMutationId(clientId: String): Int

    // Sync bookkeeping
    suspend fun getCookie(): String?
    suspend fun setCookie(cookie: String)
}

/**
 * In-memory `ClientStore` for tests, server-side rendering, and ephemeral
 * clients. A `Mutex` serialises access; `LinkedHashMap` preserves the insertion
 * order of confirmed rows (matching the Effect `Map`-based store), which the
 * reference subset evaluation relies on for unordered queries.
 */
class InMemoryClientStore : ClientStore {
    private val mutex = Mutex()
    private val rows = mutableMapOf<String, LinkedHashMap<RowId, StoredRow>>()
    private val journal = mutableListOf<Mutation>()
    private val counters = mutableMapOf<String, Int>()
    private var cookie: String? = null

    override suspend fun getRow(collection: String, id: RowId): StoredRow? =
        mutex.withLock { rows[collection]?.get(id) }

    override suspend fun listRows(collection: String): List<StoredRow> =
        mutex.withLock { rows[collection]?.values?.toList() ?: emptyList() }

    override suspend fun putRow(collection: String, row: StoredRow) = mutex.withLock {
        rows.getOrPut(collection) { LinkedHashMap() }[row.id] = row
    }

    override suspend fun delRow(collection: String, id: RowId) = mutex.withLock {
        rows[collection]?.remove(id)
        Unit
    }

    override suspend fun clearRows() = mutex.withLock { rows.clear() }

    override suspend fun appendMutation(mutation: Mutation) = mutex.withLock {
        journal.add(mutation)
        Unit
    }

    override suspend fun pendingMutations(): List<Mutation> =
        mutex.withLock { journal.toList() }

    override suspend fun acknowledge(clientId: String, upTo: Int) = mutex.withLock {
        journal.removeAll { it.clientId == clientId && it.mutationId <= upTo }
        Unit
    }

    override suspend fun nextMutationId(clientId: String): Int = mutex.withLock {
        val next = (counters[clientId] ?: 0) + 1
        counters[clientId] = next
        next
    }

    override suspend fun getCookie(): String? = mutex.withLock { cookie }

    override suspend fun setCookie(cookie: String) = mutex.withLock { this.cookie = cookie }
}

// ─── KeyValueStore-backed durable store ──────────────────────────────────────

/** The pluggable key-value persistence seam the durable store layers over. */
interface KeyValueStore {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun remove(key: String)
}

/** In-memory `KeyValueStore` (tests, ephemeral clients). */
class InMemoryKeyValueStore : KeyValueStore {
    private val mutex = Mutex()
    private val map = mutableMapOf<String, String>()

    override suspend fun get(key: String): String? = mutex.withLock { map[key] }
    override suspend fun set(key: String, value: String) = mutex.withLock { map[key] = value; Unit }
    override suspend fun remove(key: String) = mutex.withLock { map.remove(key); Unit }
}

/** A `KeyValueStore` over a directory of files — the JVM durable backing. */
class FileKeyValueStore(private val directory: File) : KeyValueStore {
    init {
        directory.mkdirs()
    }

    private fun fileFor(key: String): File =
        File(directory, key.replace(Regex("[^A-Za-z0-9._-]"), "_"))

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        fileFor(key).takeIf { it.exists() }?.readText()
    }

    override suspend fun set(key: String, value: String) = withContext(Dispatchers.IO) {
        fileFor(key).writeText(value)
    }

    override suspend fun remove(key: String) = withContext<Unit>(Dispatchers.IO) {
        fileFor(key).delete()
    }
}

/**
 * The durable `ClientStore` over any `KeyValueStore`, mirroring core's
 * `makeKeyValue`. Read-modify-write operations are serialised through a `Mutex`.
 */
class KeyValueClientStore(
    private val store: KeyValueStore,
    private val prefix: String = "effect-sync/",
) : ClientStore {
    private val mutex = Mutex()

    private val storedRowMapSerializer =
        MapSerializer(String.serializer(), StoredRow.serializer())
    private val mutationListSerializer = ListSerializer(Mutation.serializer())
    private val countersSerializer = MapSerializer(String.serializer(), Int.serializer())
    private val collectionsSerializer = ListSerializer(String.serializer())

    private fun key(suffix: String) = "$prefix$suffix"
    private fun rowsKey(collection: String) = key("rows/$collection")

    private suspend fun rowMap(collection: String): LinkedHashMap<RowId, StoredRow> {
        val raw = store.get(rowsKey(collection)) ?: return LinkedHashMap()
        return LinkedHashMap(EffectJson.decodeFromString(storedRowMapSerializer, raw))
    }

    private suspend fun writeRowMap(collection: String, map: Map<RowId, StoredRow>) {
        store.set(rowsKey(collection), EffectJson.encodeToString(storedRowMapSerializer, map))
    }

    private suspend fun collections(): List<String> {
        val raw = store.get(key("collections")) ?: return emptyList()
        return EffectJson.decodeFromString(collectionsSerializer, raw)
    }

    private suspend fun trackCollection(collection: String) {
        val list = collections()
        if (collection !in list) {
            store.set(key("collections"), EffectJson.encodeToString(collectionsSerializer, list + collection))
        }
    }

    private suspend fun journal(): List<Mutation> {
        val raw = store.get(key("journal")) ?: return emptyList()
        return EffectJson.decodeFromString(mutationListSerializer, raw)
    }

    private suspend fun writeJournal(entries: List<Mutation>) {
        store.set(key("journal"), EffectJson.encodeToString(mutationListSerializer, entries))
    }

    override suspend fun getRow(collection: String, id: RowId): StoredRow? = rowMap(collection)[id]

    override suspend fun listRows(collection: String): List<StoredRow> =
        rowMap(collection).values.toList()

    override suspend fun putRow(collection: String, row: StoredRow) = mutex.withLock {
        val map = rowMap(collection)
        map[row.id] = row
        writeRowMap(collection, map)
        trackCollection(collection)
    }

    override suspend fun delRow(collection: String, id: RowId) = mutex.withLock {
        val map = rowMap(collection)
        map.remove(id)
        writeRowMap(collection, map)
    }

    override suspend fun clearRows() = mutex.withLock {
        for (collection in collections()) store.remove(rowsKey(collection))
        store.set(key("collections"), EffectJson.encodeToString(collectionsSerializer, emptyList()))
    }

    override suspend fun appendMutation(mutation: Mutation) = mutex.withLock {
        writeJournal(journal() + mutation)
    }

    override suspend fun pendingMutations(): List<Mutation> = journal()

    override suspend fun acknowledge(clientId: String, upTo: Int) = mutex.withLock {
        writeJournal(journal().filter { it.clientId != clientId || it.mutationId > upTo })
    }

    override suspend fun nextMutationId(clientId: String): Int = mutex.withLock {
        val counters = store.get(key("counters"))
            ?.let { EffectJson.decodeFromString(countersSerializer, it) }
            ?: emptyMap()
        val next = (counters[clientId] ?: 0) + 1
        store.set(key("counters"), EffectJson.encodeToString(countersSerializer, counters + (clientId to next)))
        next
    }

    override suspend fun getCookie(): String? = store.get(key("cookie"))

    override suspend fun setCookie(cookie: String) = store.set(key("cookie"), cookie)
}
