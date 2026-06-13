/*
 * Predicate.kt
 *
 * The serializable expression language over row fields used by subscriptions and
 * live queries (Predicate.ts). Predicates are data — an expression tree — not
 * opaque lambdas, so they travel over the wire, get narrowed by server-side auth
 * filters, and evaluate against any storage. Core ships an in-memory evaluator;
 * this is its Kotlin twin.
 */

package au.thomasfoster.effectsync

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Comparison operators over a row field. */
@Serializable
enum class Comparison { eq, ne, gt, gte, lt, lte }

/**
 * A predicate expression tree. Literals are modelled as scalar `JsonElement`s
 * (string, number, bool, null).
 */
@Serializable
sealed class Predicate {
    /** Matches every row (the empty predicate). */
    @Serializable
    @SerialName("True")
    data object True : Predicate()

    /** Compares a top-level row field against a literal. */
    @Serializable
    @SerialName("Compare")
    data class Compare(val op: Comparison, val field: String, val value: JsonElement) : Predicate()

    /** Tests field membership in a literal set. */
    @Serializable
    @SerialName("In")
    data class In(val field: String, val values: List<JsonElement>) : Predicate()

    @Serializable
    @SerialName("And")
    data class And(val predicates: List<Predicate>) : Predicate()

    @Serializable
    @SerialName("Or")
    data class Or(val predicates: List<Predicate>) : Predicate()

    @Serializable
    @SerialName("Not")
    data class Not(val predicate: Predicate) : Predicate()

    /**
     * Evaluate this predicate against an encoded row value (in-memory semantics:
     * top-level field access, equality, ordered comparisons on same-typed
     * string/number pairs only).
     */
    fun test(row: JsonElement): Boolean = when (this) {
        is True -> true
        is Compare -> compareValues(op, fieldOf(row, field), value)
        is In -> values.contains(fieldOf(row, field))
        is And -> predicates.all { it.test(row) }
        is Or -> predicates.any { it.test(row) }
        is Not -> !predicate.test(row)
    }

    companion object {
        fun eq(field: String, value: JsonElement) = Compare(Comparison.eq, field, value)
        fun ne(field: String, value: JsonElement) = Compare(Comparison.ne, field, value)
        fun gt(field: String, value: JsonElement) = Compare(Comparison.gt, field, value)
        fun gte(field: String, value: JsonElement) = Compare(Comparison.gte, field, value)
        fun lt(field: String, value: JsonElement) = Compare(Comparison.lt, field, value)
        fun lte(field: String, value: JsonElement) = Compare(Comparison.lte, field, value)

        private fun fieldOf(row: JsonElement, name: String): JsonElement =
            (row as? JsonObject)?.get(name) ?: JsonNull

        private fun numberOf(element: JsonElement): Double? =
            (element as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

        private fun stringOf(element: JsonElement): String? =
            (element as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun compareValues(op: Comparison, left: JsonElement, right: JsonElement): Boolean {
            val leftNumber = numberOf(left)
            val rightNumber = numberOf(right)
            return when (op) {
                // Numbers compare numerically (JS `===` over doubles); other
                // values compare structurally.
                Comparison.eq ->
                    if (leftNumber != null && rightNumber != null) leftNumber == rightNumber
                    else left == right
                Comparison.ne ->
                    if (leftNumber != null && rightNumber != null) leftNumber != rightNumber
                    else left != right
                Comparison.gt, Comparison.gte, Comparison.lt, Comparison.lte -> {
                    if (leftNumber != null && rightNumber != null) {
                        ordered(op, leftNumber, rightNumber)
                    } else {
                        val leftString = stringOf(left)
                        val rightString = stringOf(right)
                        if (leftString != null && rightString != null) {
                            ordered(op, leftString, rightString)
                        } else {
                            false
                        }
                    }
                }
            }
        }

        private fun <T : Comparable<T>> ordered(op: Comparison, left: T, right: T): Boolean =
            when (op) {
                Comparison.gt -> left > right
                Comparison.gte -> left >= right
                Comparison.lt -> left < right
                Comparison.lte -> left <= right
                else -> false
            }
    }
}
