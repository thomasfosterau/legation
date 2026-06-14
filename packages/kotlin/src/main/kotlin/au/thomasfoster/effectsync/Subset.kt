/*
 * Subset.kt
 *
 * A collection subset — `(collection, where, orderBy, limit, cursor)` — is the
 * subscription unit of the protocol (Subset.ts): the thing a client registers
 * with the server, the thing auth filters narrow, and the thing a CVR tracks.
 * Live queries reuse the same shape locally. This file also carries the
 * reference in-memory evaluation other backends must match.
 *
 * Identity is structural: `Subset` is a `data class`, so equal subsets compare
 * and hash identically — the role `Subset.hash` plays in the Effect engine.
 */

package au.thomasfoster.effectsync

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Sort direction. */
@Serializable
enum class Direction { asc, desc }

/** One sort term: a top-level row field plus direction. */
@Serializable
data class OrderBy(val field: String, val direction: Direction = Direction.asc)

/** A collection subset. `limit` + `cursor` give cursor-based pagination. */
@Serializable
data class Subset(
    val collection: String,
    @SerialName("where") val where: Predicate = Predicate.True,
    val orderBy: List<OrderBy> = emptyList(),
    val limit: Int? = null,
    val cursor: String? = null,
) {
    companion object {
        private fun fieldOf(value: JsonElement, name: String): JsonElement =
            (value as? JsonObject)?.get(name) ?: JsonNull

        private fun isNull(element: JsonElement): Boolean = element is JsonNull

        private fun isLess(left: JsonElement, right: JsonElement): Boolean {
            val leftNumber = (left as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            val rightNumber = (right as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            if (leftNumber != null && rightNumber != null) return leftNumber < rightNumber
            val leftString = (left as? JsonPrimitive)?.takeIf { it.isString }?.content
            val rightString = (right as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (leftString != null && rightString != null) return leftString < rightString
            return false
        }

        private fun compare(orderBy: List<OrderBy>, a: JsonElement, b: JsonElement): Int {
            for (term in orderBy) {
                val left = fieldOf(a, term.field)
                val right = fieldOf(b, term.field)
                if (left == right) continue
                if (isNull(left)) return if (term.direction == Direction.asc) -1 else 1
                if (isNull(right)) return if (term.direction == Direction.asc) 1 else -1
                val ordered = if (isLess(left, right)) -1 else 1
                return if (term.direction == Direction.asc) ordered else -ordered
            }
            return 0
        }

        /**
         * Reference in-memory evaluation of a subset over `(id, value)` rows:
         * filter by predicate, sort (stably), apply cursor (rows strictly after
         * the row whose id equals the cursor), and limit. The memory backend, the
         * client mirror, and any alternative backend must match these semantics.
         */
        fun <Row : RowLike> apply(rows: List<Row>, subset: Subset): List<Row> {
            var result = rows.filter { subset.where.test(it.value) }
            if (subset.orderBy.isNotEmpty()) {
                // `sortedWith` is stable, matching JS `toSorted`.
                result = result.sortedWith { a, b -> compare(subset.orderBy, a.value, b.value) }
            }
            subset.cursor?.let { cursor ->
                val index = result.indexOfFirst { it.id == cursor }
                if (index >= 0) result = result.drop(index + 1)
            }
            subset.limit?.let { limit ->
                result = result.take(limit)
            }
            return result
        }
    }
}
