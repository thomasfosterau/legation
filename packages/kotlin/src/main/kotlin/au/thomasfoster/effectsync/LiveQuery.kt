/*
 * LiveQuery.kt
 *
 * Read-side UI integration (LiveQuery.ts). The Effect engine binds a live query
 * to an `Atom` whose value re-emits on every local change. In Kotlin the live
 * query IS a `Flow` — `SyncEngine.observe(_)` already re-emits on every change —
 * so the SwiftUI `Atom`/`@Observable` binding becomes idiomatic Kotlin Flow
 * consumption. In Jetpack Compose:
 *
 * ```kotlin
 * val todos by engine.observeAs<Todo>(openTodos).collectAsState(initial = emptyList())
 * LazyColumn { items(todos) { Text(it.title) } }
 * ```
 *
 * These helpers decode each emission into a typed model.
 */

package au.thomasfoster.effectsync

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.serializer

/** Query the current local view and decode each row into a typed model. */
suspend inline fun <reified T> SyncEngine.queryAs(subset: Subset): List<T> {
    val serializer = serializer<T>()
    return query(subset).map { EffectJson.decodeFromJsonElement(serializer, it.value) }
}

/** Observe a subset as a `Flow` of typed, decoded rows. */
inline fun <reified T> SyncEngine.observeAs(subset: Subset): Flow<List<T>> {
    val serializer = serializer<T>()
    return observe(subset).map { rows ->
        rows.map { EffectJson.decodeFromJsonElement(serializer, it.value) }
    }
}
