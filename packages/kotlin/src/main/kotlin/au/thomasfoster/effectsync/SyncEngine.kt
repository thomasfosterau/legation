/*
 * SyncEngine.kt
 *
 * The client-side engine (ClientEngine.ts): optimistic mutations into the
 * journal, local materialization (confirmed rows + optimistic overlay),
 * subscriptions, and the sync loop (push journal, pull patches, rebase).
 *
 * Rebase is recomputation (ADR-0008): the materialized view is always "confirmed
 * rows with pending mutations replayed on top", so applying a patch and dropping
 * acknowledged mutations IS the rebase — revealed through a single change signal.
 *
 * Where the Effect engine is a `Context.Service` synchronised with a `Semaphore`
 * and a change `PubSub`, the Kotlin engine guards its state with a `Mutex` and
 * signals changes through a `MutableSharedFlow`, so `observe` is a cold `Flow`
 * that re-queries on every change.
 */

package au.thomasfoster.effectsync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement

class SyncEngine(
    val clientId: String,
    val clientGroupId: String,
    private val mutators: MutatorRegistry,
    private val store: ClientStore,
    private val transport: ClientTransport,
) {
    private val mutex = Mutex()
    private var subscriptions: List<Subset> = emptyList()

    /** Change signal: every state transition emits, re-running live queries. */
    private val changes = MutableSharedFlow<Unit>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    private fun publishChange() {
        changes.tryEmit(Unit)
    }

    // ─── Materialization (confirmed rows + replayed overlay) ─────────────────

    /**
     * The local write surface used during materialization. Seeds each touched
     * collection from confirmed rows once, then applies overlay writes on top —
     * `get` reads through the in-progress view exactly like ClientEngine.ts.
     */
    private inner class MaterializeWriter : LocalWriter {
        val collections = LinkedHashMap<String, LinkedHashMap<RowId, LocalRow>>()
        private val seeded = mutableSetOf<String>()

        private suspend fun ensure(collection: String) {
            if (collections.containsKey(collection)) return
            val map = LinkedHashMap<RowId, LocalRow>()
            if (seeded.add(collection)) {
                for (row in store.listRows(collection)) {
                    map[row.id] = LocalRow(row.id, row.value)
                }
            }
            collections[collection] = map
        }

        override suspend fun put(collection: String, id: RowId, value: JsonElement) {
            ensure(collection)
            collections.getValue(collection)[id] = LocalRow(id, value)
        }

        override suspend fun del(collection: String, id: RowId) {
            ensure(collection)
            collections.getValue(collection).remove(id)
        }

        override suspend fun get(collection: String, id: RowId): JsonElement? {
            ensure(collection)
            return collections.getValue(collection)[id]?.value
        }
    }

    private suspend fun materialize(): MaterializeWriter {
        val writer = MaterializeWriter()
        for (mutation in store.pendingMutations()) {
            val entry = mutators.entries[mutation.mutator]
                ?: throw SyncException.MutatorError(
                    "Unknown mutator: ${mutation.mutator}",
                    mutation.mutator,
                )
            entry.run(mutation.args, writer)
        }
        return writer
    }

    /** Query the current local view (confirmed + overlay). */
    suspend fun query(subset: Subset): List<LocalRow> {
        val writer = materialize()
        val map = writer.collections[subset.collection] ?: run {
            // Ensure confirmed rows for the queried collection are loaded even
            // when no pending mutation touched it.
            val loaded = LinkedHashMap<RowId, LocalRow>()
            for (row in store.listRows(subset.collection)) {
                loaded[row.id] = LocalRow(row.id, row.value)
            }
            loaded
        }
        return Subset.apply(map.values.toList(), subset)
    }

    // ─── Subscriptions ───────────────────────────────────────────────────────

    /** Register/replace the engine's subscriptions (synced on next pull). */
    suspend fun subscribe(subset: Subset) = mutex.withLock {
        if (subset !in subscriptions) subscriptions = subscriptions + subset
    }

    suspend fun unsubscribe(subset: Subset) = mutex.withLock {
        subscriptions = subscriptions.filter { it != subset }
    }

    // ─── Mutations ─────────────────────────────────────────────────────────

    /**
     * Run a mutator optimistically and journal it for push. Args are validated
     * by encoding and journaled in their wire/persistence form; handlers always
     * receive decoded args.
     */
    suspend fun <Args> mutate(mutator: Mutator<Args>, args: Args) {
        if (!mutators.entries.containsKey(mutator.name)) {
            throw SyncException.MutatorError("Unknown mutator: ${mutator.name}", mutator.name)
        }
        val encoded = try {
            EffectJson.encodeToJsonElement(mutator.serializer, args)
        } catch (cause: Exception) {
            throw SyncException.MutatorError(
                "Invalid args for mutator \"${mutator.name}\"",
                mutator.name,
            )
        }
        journal(mutator.name, encoded)
    }

    /**
     * Run a mutator whose args are already in encoded (wire) form — the entry
     * point for remote surfaces forwarding mutations over a carrier. Args are
     * validated by decoding.
     */
    suspend fun mutateEncoded(mutator: String, args: JsonElement) {
        val entry = mutators.entries[mutator]
            ?: throw SyncException.MutatorError("Unknown mutator: $mutator", mutator)
        entry.validate(args)
        journal(mutator, args)
    }

    private suspend fun journal(mutator: String, encoded: JsonElement) {
        val mutationId = store.nextMutationId(clientId)
        store.appendMutation(
            Mutation(
                clientId = clientId,
                mutationId = mutationId,
                mutator = mutator,
                args = encoded,
                createdAt = System.currentTimeMillis().toDouble(),
            ),
        )
        publishChange()
    }

    // ─── Sync (push / pull / rebase) ─────────────────────────────────────────

    private suspend fun applyPatch(ops: List<PatchOp>) {
        for (op in ops) when (op) {
            is PatchOp.Clear -> store.clearRows()
            is PatchOp.Put -> store.putRow(op.collection, StoredRow(op.id, op.version, op.value))
            is PatchOp.Del -> store.delRow(op.collection, op.id)
        }
    }

    private suspend fun acknowledge(lastMutationIds: Map<String, Int>) {
        for ((clientId, upTo) in lastMutationIds) store.acknowledge(clientId, upTo)
    }

    /** Push pending mutations now. */
    suspend fun push() {
        val pending = store.pendingMutations()
        if (pending.isEmpty()) return
        val response = transport.push(PushRequest(clientGroupId, pending))
        // Effects arrive via the next pull; the ack only trims the journal.
        acknowledge(response.lastMutationIds)
        publishChange()
    }

    /** Pull a patch now and rebase. */
    suspend fun pull() {
        val cookie = store.getCookie()
        val subsets = mutex.withLock { subscriptions }
        val response = transport.pull(PullRequest(clientGroupId, cookie, subsets))
        applyPatch(response.patch)
        acknowledge(response.lastMutationIds)
        store.setCookie(response.cookie)
        // Atomic reveal: one change signal after patch + ack (rebase is
        // recomputation in `materialize`).
        publishChange()
    }

    /**
     * Run the sync loop in [scope]: pull on poke; push+pull on (re)connect.
     * Returns the [Job]; cancel it to stop the loop.
     */
    fun runSync(scope: CoroutineScope): Job = scope.launch {
        launch {
            transport.pokes().collect { runCatching { pull() } }
        }
        launch {
            transport.statusChanges().collect { status ->
                if (status == ConnectionStatus.CONNECTED) {
                    runCatching { push() }
                    runCatching { pull() }
                }
            }
        }
    }

    // ─── Observation ─────────────────────────────────────────────────────────

    /** Live query: emits the result now and after every local change. */
    fun observe(subset: Subset): Flow<List<LocalRow>> =
        changes
            .onStart { emit(Unit) }
            .map { query(subset) }
}
