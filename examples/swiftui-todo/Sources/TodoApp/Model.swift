import EffectSync

/// A todo row. The same `Codable` type is the collection's row and the
/// `todo/set` mutator's args — exactly as a shared collection definition would
/// be in the TypeScript engine.
struct Todo: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let title: String
    let done: Bool
}

struct RemoveArgs: Codable, Sendable {
    let id: String
}

/// Mutator contracts, shared by the client handlers and the demo backend.
let setTodo = Mutator<Todo>("todo/set")
let removeTodo = Mutator<RemoveArgs>("todo/remove")

/// The subset every view subscribes to and observes.
let allTodos = Subset(collection: "todos", orderBy: [OrderBy(field: "title")])
