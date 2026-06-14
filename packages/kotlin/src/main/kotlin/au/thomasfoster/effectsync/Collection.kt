/*
 * Collection.kt
 *
 * A collection is a named, schema-typed set of rows keyed by row id — the unit
 * the client materializes locally and queries (Collection.ts). The Effect
 * definition carries an `effect/Schema` codec; the Kotlin definition carries the
 * row type's `KSerializer`, with `JsonElement` bridging providing encode/decode.
 */

package au.thomasfoster.effectsync

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

/** The identifier of one row within a collection. */
typealias RowId = String

/**
 * An opaque per-row token the backend changes on every authoritative write —
 * the basis for CVR diffing (ADR-0008). The wire form is `string | number`.
 */
@Serializable(with = RowVersion.Serializer::class)
sealed class RowVersion {
    data class Str(val value: String) : RowVersion()
    data class Num(val value: Double) : RowVersion()

    companion object {
        fun of(value: Int): RowVersion = Num(value.toDouble())
        fun of(value: String): RowVersion = Str(value)
    }

    object Serializer : KSerializer<RowVersion> {
        override val descriptor: SerialDescriptor =
            PrimitiveSerialDescriptor("RowVersion", PrimitiveKind.STRING)

        override fun serialize(encoder: Encoder, value: RowVersion) {
            val json = encoder as? JsonEncoder
                ?: error("RowVersion can only be serialized to JSON")
            val element = when (value) {
                is Str -> JsonPrimitive(value.value)
                is Num -> JsonPrimitive(value.value)
            }
            json.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): RowVersion {
            val json = decoder as? JsonDecoder
                ?: error("RowVersion can only be deserialized from JSON")
            val primitive = json.decodeJsonElement().jsonPrimitive
            return if (primitive.isString) Str(primitive.content) else Num(primitive.double)
        }
    }
}

/**
 * Anything addressable as `(id, encoded value)` — the shape subset evaluation
 * and predicates operate over.
 */
interface RowLike {
    val id: RowId
    val value: JsonElement
}

/** A confirmed row as persisted: encoded value plus authoritative version. */
@Serializable
data class StoredRow(
    override val id: RowId,
    val version: RowVersion,
    override val value: JsonElement,
) : RowLike

/**
 * A locally-materialized row: confirmed rows with the optimistic overlay
 * replayed on top carry no version yet, so only `(id, value)` is exposed.
 */
data class LocalRow(
    override val id: RowId,
    override val value: JsonElement,
) : RowLike {
    /** Decode the row's encoded value into a typed model. */
    inline fun <reified T> decode(): T = value.decodeAs()
}

/**
 * A collection definition. `Value` is the decoded row type; rows cross the
 * engine boundary in their `JsonElement` encoded form.
 */
class SyncCollection<Value>(
    val name: String,
    val serializer: KSerializer<Value>,
    val id: (Value) -> RowId,
)

/** Define a collection, deriving the row serializer from the reified type. */
inline fun <reified Value> syncCollection(
    name: String,
    noinline id: (Value) -> RowId,
): SyncCollection<Value> = SyncCollection(name, serializer(), id)
