package au.thomasfoster.effectsync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class WireFormatTest {
    @Test
    fun typedBridging() {
        val encoded = encodeToJsonElement(Todo("1", "ship", false))
        assertEquals("1", encoded.jsonObject["id"]?.jsonPrimitive?.content)
        assertEquals("ship", encoded.jsonObject["title"]?.jsonPrimitive?.content)
        assertEquals(Todo("1", "ship", false), encoded.decodeAs<Todo>())
    }

    @Test
    fun patchOpTaggedUnion() {
        val put: PatchOp = PatchOp.Put("todos", "1", RowVersion.of(3), encodeToJsonElement("v"))
        val text = EffectJson.encodeToString(PatchOp.serializer(), put)
        assertEquals("Put", EffectJson.parseToJsonElement(text).jsonObject["_tag"]?.jsonPrimitive?.content)
        assertEquals(put, EffectJson.decodeFromString(PatchOp.serializer(), text))

        val clear: PatchOp = PatchOp.Clear
        val clearText = EffectJson.encodeToString(PatchOp.serializer(), clear)
        assertEquals(clear, EffectJson.decodeFromString(PatchOp.serializer(), clearText))
    }

    @Test
    fun rowVersionEncodesAsBareScalar() {
        assertEquals(RowVersion.Num(5.0), EffectJson.decodeFromString(RowVersion.serializer(), "5"))
        assertEquals(RowVersion.Str("abc"), EffectJson.decodeFromString(RowVersion.serializer(), "\"abc\""))
    }

    @Test
    fun pullRequestOmitsAbsentCookie() {
        val request = PullRequest(clientGroupId = "g", cookie = null, subscriptions = emptyList())
        val text = EffectJson.encodeToString(PullRequest.serializer(), request)
        assertFalse(EffectJson.parseToJsonElement(text).jsonObject.containsKey("cookie"))
    }
}
