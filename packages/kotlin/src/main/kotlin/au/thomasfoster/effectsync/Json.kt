/*
 * Json.kt
 *
 * The engine moves rows and mutator args around in their *encoded*
 * (wire/persistence) form. In the Effect implementation that form is
 * TypeScript's `unknown` — arbitrary JSON validated by an `effect/Schema`
 * codec. Kotlin's natural "arbitrary JSON" type is kotlinx.serialization's
 * `JsonElement`, and `@Serializable` plays the role the schema codec plays:
 * typed values cross into the engine by encoding to `JsonElement` and come back
 * out by decoding from it. A decode failure is exactly the validation failure
 * the schema would raise.
 */

package au.thomasfoster.effectsync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer

/**
 * The single `Json` configuration the engine encodes and decodes with.
 *
 * - `classDiscriminator = "_tag"` matches the tagged-union wire shape the Effect
 *   protocol uses (`_tag: "Put"`, `_tag: "Compare"`, …).
 * - `explicitNulls = false` omits absent optional fields (e.g. a missing pull
 *   `cookie`), matching `effect/Schema`'s `optional`.
 * - `ignoreUnknownKeys = true` keeps forward compatibility with newer servers.
 */
val EffectJson: Json = Json {
    classDiscriminator = "_tag"
    explicitNulls = false
    ignoreUnknownKeys = true
    encodeDefaults = true
}

/** Encode any serializable value to its `JsonElement` form. */
inline fun <reified T> encodeToJsonElement(value: T): JsonElement =
    EffectJson.encodeToJsonElement(serializer<T>(), value)

/** Decode this `JsonElement` into a typed value, validating its shape. */
inline fun <reified T> JsonElement.decodeAs(): T =
    EffectJson.decodeFromJsonElement(serializer<T>(), this)
