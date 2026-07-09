/**
 * App
 *
 * The whole UI. Todos come from `useQuery(allTodos)` (live: re-renders on every
 * mutation, push ack, and pull/rebase); writes go through `useMutation`
 * optimistically. The journal/mutation timeline, subscriptions, sync activity,
 * and actions all now live in the `@legation/devtools` panel (#120) — this
 * component no longer reads `useMutationState()` for a bespoke journal UI. The
 * demo knobs (offline, remote edit) come from the demo context. Visual design
 * and behaviour mirror the FoldKit / Compose / SwiftUI todo examples.
 */
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMutation, useQuery } from "@legation/react";
import type { DevtoolsCore } from "@legation/devtools";
import { DevtoolsPanel } from "@legation/devtools/react";
import { type Todo, allTodos } from "./domain";
import { useConnection, useDemo } from "./demo";

type Filter = "All" | "Active" | "Completed";

const connectionLabel = (status: string): string =>
  status === "connected" ? "online" : status === "disconnected" ? "offline" : "connecting…";

const filterTodos = (todos: ReadonlyArray<Todo>, filter: Filter): ReadonlyArray<Todo> =>
  filter === "All"
    ? todos
    : filter === "Active"
      ? todos.filter((todo) => !todo.done)
      : todos.filter((todo) => todo.done);

export const App = (props: { readonly devtools: DevtoolsCore }): React.ReactElement => {
  const rowsResult = useQuery(allTodos);
  const rows = AsyncResult.getOrElse(rowsResult, () => []);
  const todos = React.useMemo(() => rows.map((row) => row.value as Todo), [rows]);
  const mutate = useMutation();
  const controls = useDemo();
  const connection = useConnection();

  const [draft, setDraft] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("All");
  const [remoteAgent, setRemoteAgent] = React.useState(false);
  const [lastSyncAt, setLastSyncAt] = React.useState<number | null>(null);

  // The simulated remote agent: writes to the backend on a timer while on.
  React.useEffect(() => {
    if (!remoteAgent) return;
    const timer = window.setInterval(() => void controls.simulateRemote(), 4000);
    return () => window.clearInterval(timer);
  }, [remoteAgent, controls]);

  const offline = connection === "disconnected";
  const total = todos.length;
  const active = todos.filter((todo) => !todo.done).length;
  const completed = total - active;
  const visible = filterTodos(todos, filter);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const title = draft.trim();
    if (title.length === 0) return;
    setDraft("");
    void mutate("todo/set", {
      id: crypto.randomUUID(),
      title,
      done: false,
      createdAt: Date.now(),
    });
  };

  const toggle = (todo: Todo): void => {
    // Mutators re-run on every rebase, so toggling is a full idempotent put.
    void mutate("todo/set", { ...todo, done: !todo.done });
  };

  return (
    <div className="app">
      <div className="card">
        <h1 className="title">legation · React</h1>
        <p className="subtitle">
          Offline-first todos: optimistic writes, live views, push/pull rebase.
        </p>

        <div className="status-bar">
          <span className={`pill pill-${connection}`}>● {connectionLabel(connection)}</span>
          <span className="muted">
            {lastSyncAt === null ? "" : `last sync ${new Date(lastSyncAt).toLocaleTimeString()}`}
          </span>
        </div>

        <div className="controls">
          <button
            className={offline ? "btn btn-warn" : "btn"}
            onClick={() => void controls.setOnline(offline)}
          >
            {offline ? "Go online" : "Go offline"}
          </button>
          <button
            className="btn"
            onClick={() =>
              void controls.syncNow().then(() => setLastSyncAt(Date.now()))
            }
          >
            Sync now
          </button>
          <button className="btn" onClick={() => void controls.simulateRemote()}>
            Remote edit
          </button>
          <button
            className={remoteAgent ? "btn btn-active" : "btn"}
            onClick={() => setRemoteAgent((on) => !on)}
          >
            {remoteAgent ? "Remote agent: on" : "Remote agent: off"}
          </button>
        </div>

        <form className="add-form" onSubmit={submit}>
          <input
            className="add-input"
            value={draft}
            placeholder={offline ? "Offline — writes will queue" : "What needs doing?"}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Add
          </button>
        </form>

        <div className="tabs">
          {(["All", "Active", "Completed"] as const).map((tab) => (
            <button
              key={tab}
              className={filter === tab ? "tab tab-active" : "tab"}
              onClick={() => setFilter(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="empty">Nothing here yet.</div>
        ) : (
          <ul className="todo-list">
            {visible.map((todo) => (
              <li key={todo.id} className={todo.done ? "todo todo-done" : "todo"}>
                <label className="todo-main">
                  <input type="checkbox" checked={todo.done} onChange={() => toggle(todo)} />
                  <span className="todo-title">{todo.title}</span>
                </label>
                <button
                  className="link link-danger"
                  onClick={() => void mutate("todo/remove", { id: todo.id })}
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="footer">
          <span>
            {active} active · {completed} completed · {total} total
          </span>
          {completed > 0 ? (
            <button
              className="link"
              onClick={() =>
                todos
                  .filter((todo) => todo.done)
                  .forEach((todo) => void mutate("todo/remove", { id: todo.id }))
              }
            >
              clear completed
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </div>

        <DevtoolsPanel core={props.devtools} />
      </div>
    </div>
  );
};
