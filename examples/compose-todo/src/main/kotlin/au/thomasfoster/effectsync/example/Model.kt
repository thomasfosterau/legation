package au.thomasfoster.effectsync.example

import au.thomasfoster.effectsync.Subset
import au.thomasfoster.effectsync.mutator
import kotlinx.serialization.Serializable

/** A todo row. The same `@Serializable` type is the collection's row and the
 *  `todo/set` mutator's args — exactly as a shared collection definition would
 *  be in the TypeScript engine. */
@Serializable
data class Todo(val id: String, val title: String, val done: Boolean)

@Serializable
data class RemoveArgs(val id: String)

/** Mutator contracts, shared by the client handlers and the demo backend. */
val setTodo = mutator<Todo>("todo/set")
val removeTodo = mutator<RemoveArgs>("todo/remove")

/** The subset every view subscribes to and observes. */
val allTodos = Subset(collection = "todos", orderBy = listOf(au.thomasfoster.effectsync.OrderBy("title")))
