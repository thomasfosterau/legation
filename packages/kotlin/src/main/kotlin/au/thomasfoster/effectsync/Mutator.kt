/*
 * Mutator.kt
 *
 * A mutator is a named, schema-validated write intent defined once and executed
 * twice: optimistically on the client and authoritatively on the backend
 * (Mutator.ts, ADR-0008). Conflict resolution IS replay — the local handler runs
 * once optimistically and again on every rebase, so handlers must be re-runnable.
 *
 * The Effect version validates args with an `effect/Schema` codec; here the args
 * type carries a `KSerializer` and `JsonElement` bridging is the codec.
 */

package au.thomasfoster.effectsync

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer

/** A mutator definition: the shared, serializable contract. */
class Mutator<Args>(val name: String, val serializer: KSerializer<Args>)

/** Define a mutator, deriving the args serializer from the reified type. */
inline fun <reified Args> mutator(name: String): Mutator<Args> =
    Mutator(name, serializer())

/**
 * The local write surface handed to client-side mutator handlers. Writes apply
 * to the optimistic overlay only; authoritative versions arrive via patches.
 */
interface LocalWriter {
    /** Write a row's encoded value into the overlay. */
    suspend fun put(collection: String, id: RowId, value: JsonElement)
    suspend fun del(collection: String, id: RowId)
    /** Read through confirmed rows + overlay (the current local view). */
    suspend fun get(collection: String, id: RowId): JsonElement?
}

/** Write a typed row value, encoding it to its `JsonElement` form. */
suspend inline fun <reified V> LocalWriter.put(collection: String, id: RowId, value: V) =
    put(collection, id, encodeToJsonElement(value))

/** Read a row and decode it into a typed model, if present. */
suspend inline fun <reified V> LocalWriter.get(collection: String, id: RowId): V? =
    get(collection, id)?.decodeAs()

/** A client-side handler for one mutator, type-erased over `JsonElement` args. */
internal class MutatorEntry(
    val name: String,
    /** Decode args and run the handler against the writer. */
    val run: suspend (JsonElement, LocalWriter) -> Unit,
    /** Validate encoded args by decoding them, without running anything. */
    val validate: (JsonElement) -> Unit,
)

/** A set of mutator definitions paired with their client-side handlers. */
class MutatorRegistry {
    internal val entries = mutableMapOf<String, MutatorEntry>()

    /**
     * Pair a mutator definition with its re-runnable local handler. Handlers
     * receive decoded args; a duplicate name is a programmer error and throws.
     */
    fun <Args> register(
        mutator: Mutator<Args>,
        handler: suspend (Args, LocalWriter) -> Unit,
    ) {
        require(!entries.containsKey(mutator.name)) { "Duplicate mutator name: ${mutator.name}" }
        val name = mutator.name
        entries[name] = MutatorEntry(
            name = name,
            run = { encoded, writer ->
                val args = try {
                    EffectJson.decodeFromJsonElement(mutator.serializer, encoded)
                } catch (cause: Exception) {
                    throw SyncException.MutatorError(
                        "Invalid journaled args for mutator \"$name\"",
                        mutator = name,
                    )
                }
                handler(args, writer)
            },
            validate = { encoded ->
                try {
                    EffectJson.decodeFromJsonElement(mutator.serializer, encoded)
                } catch (cause: Exception) {
                    throw SyncException.MutatorError(
                        "Invalid args for mutator \"$name\"",
                        mutator = name,
                    )
                }
            },
        )
    }
}

/** Build a registry from a configuration block. */
fun mutatorRegistry(build: MutatorRegistry.() -> Unit): MutatorRegistry =
    MutatorRegistry().apply(build)
