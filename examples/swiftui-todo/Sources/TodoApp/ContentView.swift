import EffectSync
import SwiftUI

struct ContentView: View {
    let engine: SyncEngine

    // The live query: an `@Observable` `LiveQuery` whose `rows` re-emit on every
    // local change (mutation, push ack, pull/rebase). Reading `todos.rows` in
    // `body` makes SwiftUI re-render when they change.
    @State private var todos: LiveQuery<Todo>
    @State private var draft = ""

    init(engine: SyncEngine) {
        self.engine = engine
        _todos = State(initialValue: LiveQuery(engine: engine, subset: allTodos, of: Todo.self))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Todos").font(.title)

            HStack {
                TextField("New todo", text: $draft)
                    .textFieldStyle(.roundedBorder)
                Button("Add", action: add)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            HStack {
                Text("\(todos.rows.filter { !$0.done }.count) open · \(todos.rows.count) total")
                Spacer()
                Button("Sync now") {
                    Task { try? await engine.push(); try? await engine.pull() }
                }
            }

            Divider()

            List(todos.rows) { todo in
                HStack {
                    // Mutators run twice — optimistically here and again on every
                    // rebase — so a re-run must be idempotent.
                    Button {
                        Task {
                            try? await engine.mutate(
                                setTodo,
                                Todo(id: todo.id, title: todo.title, done: !todo.done)
                            )
                        }
                    } label: {
                        Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                    }
                    .buttonStyle(.plain)

                    Text(todo.title).strikethrough(todo.done)
                    Spacer()

                    Button("Delete") {
                        Task { try? await engine.mutate(removeTodo, RemoveArgs(id: todo.id)) }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding()
        .task {
            await engine.subscribe(allTodos)
            // The loopback transport reports "connected" immediately, so the sync
            // loop pushes + pulls right away.
            await engine.runSync()
        }
    }

    private func add() {
        let title = draft.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        draft = ""
        // Optimistic: the new row appears in `todos.rows` immediately, before the
        // push/pull round trip confirms it.
        Task { try? await engine.mutate(setTodo, Todo(id: UUID().uuidString, title: title, done: false)) }
    }
}
