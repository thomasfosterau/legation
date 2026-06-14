package au.thomasfoster.effectsync.example

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.Button
import androidx.compose.material.Checkbox
import androidx.compose.material.Divider
import androidx.compose.material.MaterialTheme
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import au.thomasfoster.effectsync.SyncEngine
import au.thomasfoster.effectsync.observeAs
import java.util.UUID
import kotlinx.coroutines.launch

fun main() = application {
    val engine = remember { buildDemoEngine() }

    // Subscribe once, then run the background sync loop (which pushes + pulls on
    // connect — the loopback transport reports "connected" immediately).
    LaunchedEffect(engine) {
        engine.subscribe(allTodos)
        engine.runSync(this)
    }

    Window(onCloseRequest = ::exitApplication, title = "EffectSync · Compose") {
        MaterialTheme {
            TodoScreen(engine)
        }
    }
}

@Composable
private fun TodoScreen(engine: SyncEngine) {
    val scope = rememberCoroutineScope()

    // The live query: a Flow of decoded rows collected as Compose state. It
    // re-emits on every optimistic write and every pull/rebase.
    val todos by engine.observeAs<Todo>(allTodos).collectAsState(initial = emptyList())

    var draft by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Todos", style = MaterialTheme.typography.h5)
        Spacer(Modifier.height(12.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                label = { Text("New todo") },
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Button(
                enabled = draft.isNotBlank(),
                onClick = {
                    val title = draft.trim()
                    draft = ""
                    scope.launch {
                        // Optimistic: the new row appears in `todos` immediately,
                        // before the push/pull round trip confirms it.
                        engine.mutate(setTodo, Todo(UUID.randomUUID().toString(), title, false))
                    }
                },
            ) { Text("Add") }
        }

        Spacer(Modifier.height(12.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("${todos.count { !it.done }} open · ${todos.size} total")
            Button(onClick = { scope.launch { engine.push(); engine.pull() } }) { Text("Sync now") }
        }

        Divider(Modifier.padding(vertical = 8.dp))

        LazyColumn {
            items(todos, key = { it.id }) { todo ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = todo.done,
                        onCheckedChange = { checked ->
                            // Mutators run twice — optimistically here and again
                            // on every rebase — so a re-run must be idempotent.
                            scope.launch { engine.mutate(setTodo, todo.copy(done = checked)) }
                        },
                    )
                    Text(
                        text = todo.title,
                        modifier = Modifier.weight(1f),
                        textDecoration = if (todo.done) TextDecoration.LineThrough else null,
                    )
                    TextButton(onClick = { scope.launch { engine.mutate(removeTodo, RemoveArgs(todo.id)) } }) {
                        Text("Delete")
                    }
                }
            }
        }
    }
}
