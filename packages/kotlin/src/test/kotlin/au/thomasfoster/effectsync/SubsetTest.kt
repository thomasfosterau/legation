package au.thomasfoster.effectsync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class SubsetTest {
    private fun rows(): List<LocalRow> = listOf(
        LocalRow("1", buildJsonObject { put("n", 3); put("done", false) }),
        LocalRow("2", buildJsonObject { put("n", 1); put("done", true) }),
        LocalRow("3", buildJsonObject { put("n", 2); put("done", false) }),
    )

    @Test
    fun filter() {
        val subset = Subset(collection = "todos", where = Predicate.eq("done", JsonPrimitive(false)))
        assertEquals(listOf("1", "3"), Subset.apply(rows(), subset).map { it.id })
    }

    @Test
    fun orderByAscendingAndDescending() {
        val asc = Subset(collection = "todos", orderBy = listOf(OrderBy("n", Direction.asc)))
        assertEquals(listOf("2", "3", "1"), Subset.apply(rows(), asc).map { it.id })

        val desc = Subset(collection = "todos", orderBy = listOf(OrderBy("n", Direction.desc)))
        assertEquals(listOf("1", "3", "2"), Subset.apply(rows(), desc).map { it.id })
    }

    @Test
    fun cursorAndLimit() {
        // Ordered ids: 2, 3, 1 — cursor "3" yields rows strictly after it.
        val afterCursor = Subset(
            collection = "todos",
            orderBy = listOf(OrderBy("n", Direction.asc)),
            cursor = "3",
        )
        assertEquals(listOf("1"), Subset.apply(rows(), afterCursor).map { it.id })

        val limited = Subset(
            collection = "todos",
            orderBy = listOf(OrderBy("n", Direction.asc)),
            limit = 2,
        )
        assertEquals(listOf("2", "3"), Subset.apply(rows(), limited).map { it.id })
    }

    @Test
    fun identityIsStructural() {
        val a = Subset(collection = "todos", where = Predicate.eq("done", JsonPrimitive(false)))
        val b = Subset(collection = "todos", where = Predicate.eq("done", JsonPrimitive(false)))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())

        val c = Subset(collection = "todos", where = Predicate.eq("done", JsonPrimitive(true)))
        assertNotEquals(a, c)
    }

    @Test
    fun wireRoundTripUsesWhereKey() {
        val subset = Subset(
            collection = "todos",
            where = Predicate.eq("done", JsonPrimitive(false)),
            orderBy = listOf(OrderBy("n", Direction.asc)),
            limit = 10,
        )
        val text = EffectJson.encodeToString(Subset.serializer(), subset)
        assertEquals(subset, EffectJson.decodeFromString(Subset.serializer(), text))
        assertEquals(true, EffectJson.parseToJsonElement(text).jsonObject.containsKey("where"))
    }
}
