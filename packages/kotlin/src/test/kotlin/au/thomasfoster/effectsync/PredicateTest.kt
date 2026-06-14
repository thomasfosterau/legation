package au.thomasfoster.effectsync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class PredicateTest {
    private fun row(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonElement =
        buildJsonObject(build)

    @Test
    fun comparisons() {
        val r = row { put("n", 5); put("s", "b") }
        assertTrue(Predicate.eq("n", JsonPrimitive(5)).test(r))
        assertFalse(Predicate.eq("n", JsonPrimitive(6)).test(r))
        assertTrue(Predicate.ne("n", JsonPrimitive(6)).test(r))
        assertTrue(Predicate.gt("n", JsonPrimitive(4)).test(r))
        assertTrue(Predicate.gte("n", JsonPrimitive(5)).test(r))
        assertTrue(Predicate.lt("n", JsonPrimitive(6)).test(r))
        assertTrue(Predicate.lte("n", JsonPrimitive(5)).test(r))
        assertTrue(Predicate.lt("s", JsonPrimitive("c")).test(r))
    }

    @Test
    fun mixedTypeOrderedComparisonsAreFalse() {
        val r = row { put("n", 5) }
        assertFalse(Predicate.gt("n", JsonPrimitive("4")).test(r))
    }

    @Test
    fun inAndBooleanCombinators() {
        val r = row { put("status", "open"); put("done", false) }
        assertTrue(Predicate.In("status", listOf(JsonPrimitive("open"), JsonPrimitive("wip"))).test(r))
        assertFalse(Predicate.In("status", listOf(JsonPrimitive("closed"))).test(r))

        val p = Predicate.And(
            listOf(
                Predicate.eq("done", JsonPrimitive(false)),
                Predicate.Not(Predicate.eq("status", JsonPrimitive("closed"))),
            ),
        )
        assertTrue(p.test(r))
        assertTrue(
            Predicate.Or(
                listOf(
                    Predicate.eq("done", JsonPrimitive(true)),
                    Predicate.eq("status", JsonPrimitive("open")),
                ),
            ).test(r),
        )
    }

    @Test
    fun missingFieldIsNull() {
        val r = row { put("a", 1) }
        assertTrue(Predicate.eq("missing", JsonNull).test(r))
        assertFalse(Predicate.eq("missing", JsonPrimitive(1)).test(r))
    }

    @Test
    fun wireRoundTrip() {
        val original = Predicate.And(
            listOf(
                Predicate.eq("done", JsonPrimitive(false)),
                Predicate.In("tag", listOf(JsonPrimitive("x"), JsonPrimitive("y"))),
            ),
        )
        val text = EffectJson.encodeToString(Predicate.serializer(), original)
        val decoded = EffectJson.decodeFromString(Predicate.serializer(), text)
        assertEquals(original, decoded)

        // The encoded form is the tagged-union wire shape.
        val tag = EffectJson.parseToJsonElement(text).jsonObject["_tag"]?.jsonPrimitive?.content
        assertEquals("And", tag)
    }
}
