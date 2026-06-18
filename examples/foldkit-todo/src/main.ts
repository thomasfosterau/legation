/**
 * FoldKit application (The Elm Architecture)
 *
 * One immutable `Model`, one `update`, one `view`. Every change flows through
 * `update`; side effects are values (`Command`s) the runtime runs, and live
 * data arrives as `Subscription` streams turned into messages.
 *
 * The sync engine lives behind the {@link SyncWorld} handle (`sync.ts`):
 *   - user actions issue commands that call the engine optimistically;
 *   - subscriptions stream the engine's live view, connection status, and the
 *     durable journal back into the model.
 */

import { Clock, Duration, Effect, Match as M, Random, Schema as S, Stream } from "effect";
import { Command, Runtime, Subscription } from "foldkit";
import { type Document, type Html, html } from "foldkit/html";
import { m } from "foldkit/message";

import { Todo } from "./domain";
import { getWorld } from "./sync";

// ─── Model ───────────────────────────────────────────────────────────────────

const Filter = S.Literals(["All", "Active", "Completed"]);
type Filter = typeof Filter.Type;

const ConnectionStatus = S.Literals(["connecting", "connected", "disconnected"]);

const PendingEntry = S.Struct({ mutationId: S.Number, summary: S.String });

export const Model = S.Struct({
  /** The live local view of `allTodos` (confirmed rows + optimistic overlay). */
  todos: S.Array(Todo),
  /** The new-todo input buffer. */
  draft: S.String,
  filter: Filter,
  connection: ConnectionStatus,
  /** Pending (unconfirmed) journal entries, for the "journal" panel. */
  pending: S.Array(PendingEntry),
  /** Whether the simulated remote agent is editing on a timer. */
  remoteAgent: S.Boolean,
  /** Wall-clock of the last manual "Sync now", or null. */
  lastSyncAt: S.NullOr(S.Number),
});
export type Model = typeof Model.Type;

// ─── Messages ──────────────────────────────────────────────────────────────────

// User intents
const UpdatedDraft = m("UpdatedDraft", { text: S.String });
const SubmittedDraft = m("SubmittedDraft");
const ToggledTodo = m("ToggledTodo", { id: S.String });
const DeletedTodo = m("DeletedTodo", { id: S.String });
const ClearedCompleted = m("ClearedCompleted");
const SelectedFilter = m("SelectedFilter", { filter: Filter });
const ToggledConnection = m("ToggledConnection");
const ClickedSyncNow = m("ClickedSyncNow");
const ClickedSimulateRemote = m("ClickedSimulateRemote");
const ToggledRemoteAgent = m("ToggledRemoteAgent");

// Effect / subscription results
const SyncedTodos = m("SyncedTodos", { todos: S.Array(Todo) });
const ConnectionChanged = m("ConnectionChanged", { status: ConnectionStatus });
const PendingChanged = m("PendingChanged", { pending: S.Array(PendingEntry) });
const SyncCompleted = m("SyncCompleted", { at: S.Number });
const NoOp = m("NoOp");

export const Message = S.Union([
  UpdatedDraft,
  SubmittedDraft,
  ToggledTodo,
  DeletedTodo,
  ClearedCompleted,
  SelectedFilter,
  ToggledConnection,
  ClickedSyncNow,
  ClickedSimulateRemote,
  ToggledRemoteAgent,
  SyncedTodos,
  ConnectionChanged,
  PendingChanged,
  SyncCompleted,
  NoOp,
]);
export type Message = typeof Message.Type;

// ─── Commands (side effects as values) ───────────────────────────────────────

/** Mint an id + timestamp, then issue the optimistic `todo/set`. */
const AddDraft = Command.define("AddDraft", { text: S.String }, NoOp)(({ text }) =>
  Effect.gen(function* () {
    const id = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER).pipe(
      Effect.map((value) => value.toString(36))
    );
    const createdAt = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() => getWorld().setTodo({ id, title: text, done: false, createdAt }));
    return NoOp();
  })
);

const RunSetTodo = Command.define("RunSetTodo", { todo: Todo }, NoOp)(({ todo }) =>
  Effect.promise(() => getWorld().setTodo(todo)).pipe(Effect.as(NoOp()))
);

const RunRemoveTodo = Command.define("RunRemoveTodo", { id: S.String }, NoOp)(({ id }) =>
  Effect.promise(() => getWorld().removeTodo(id)).pipe(Effect.as(NoOp()))
);

const RunSetOnline = Command.define("RunSetOnline", { online: S.Boolean }, NoOp)(({ online }) =>
  Effect.promise(() => getWorld().setOnline(online)).pipe(Effect.as(NoOp()))
);

const RunSyncNow = Command.define("RunSyncNow", {}, SyncCompleted)(() =>
  Effect.gen(function* () {
    yield* Effect.promise(() => getWorld().syncNow());
    const at = yield* Clock.currentTimeMillis;
    return SyncCompleted({ at });
  })
);

const RunSimulateRemote = Command.define("RunSimulateRemote", {}, NoOp)(() =>
  Effect.promise(() => getWorld().simulateRemote()).pipe(Effect.as(NoOp()))
);

// ─── Init ────────────────────────────────────────────────────────────────────

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  {
    todos: [],
    draft: "",
    filter: "All",
    connection: "connecting",
    pending: [],
    remoteAgent: false,
    lastSyncAt: null,
  },
  [],
];

// ─── Update ──────────────────────────────────────────────────────────────────

type Step = readonly [Model, ReadonlyArray<Command.Command<Message>>];

export const update = (model: Model, message: Message): Step =>
  M.value(message).pipe(
    M.tagsExhaustive({
      UpdatedDraft: ({ text }): Step => [{ ...model, draft: text }, []],

      SubmittedDraft: (): Step => {
        const text = model.draft.trim();
        return text.length === 0 ? [model, []] : [{ ...model, draft: "" }, [AddDraft({ text })]];
      },

      ToggledTodo: ({ id }): Step => {
        const todo = model.todos.find((candidate) => candidate.id === id);
        // Mutators re-run on every rebase, so toggling is a full idempotent put.
        return todo === undefined
          ? [model, []]
          : [model, [RunSetTodo({ todo: { ...todo, done: !todo.done } })]];
      },

      DeletedTodo: ({ id }): Step => [model, [RunRemoveTodo({ id })]],

      ClearedCompleted: (): Step => [
        model,
        model.todos.filter((todo) => todo.done).map((todo) => RunRemoveTodo({ id: todo.id })),
      ],

      SelectedFilter: ({ filter }): Step => [{ ...model, filter }, []],

      ToggledConnection: (): Step => [
        model,
        [RunSetOnline({ online: model.connection === "disconnected" })],
      ],

      ClickedSyncNow: (): Step => [model, [RunSyncNow({})]],

      ClickedSimulateRemote: (): Step => [model, [RunSimulateRemote({})]],

      ToggledRemoteAgent: (): Step => [{ ...model, remoteAgent: !model.remoteAgent }, []],

      // Live view re-emit (mutation, push ack, pull/rebase) — atomic reveal.
      SyncedTodos: ({ todos }): Step => [{ ...model, todos }, []],

      ConnectionChanged: ({ status }): Step => [{ ...model, connection: status }, []],

      PendingChanged: ({ pending }): Step => [{ ...model, pending }, []],

      SyncCompleted: ({ at }): Step => [{ ...model, lastSyncAt: at }, []],

      NoOp: (): Step => [model, []],
    })
  );

// ─── Subscriptions (live streams → messages) ─────────────────────────────────

// Constant dependencies = "start the stream once and keep it running".
const always = { on: S.Boolean };
const alwaysOn = () => ({ on: true });

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  // The live local view: re-emits on every confirmed/optimistic change.
  todos: entry(always, {
    modelToDependencies: alwaysOn,
    dependenciesToStream: () =>
      getWorld()
        .observeTodos()
        .pipe(Stream.map((todos) => SyncedTodos({ todos }))),
  }),

  // Transport connection status.
  connection: entry(always, {
    modelToDependencies: alwaysOn,
    dependenciesToStream: () =>
      getWorld()
        .connectionChanges()
        .pipe(Stream.map((status) => ConnectionChanged({ status }))),
  }),

  // The durable journal, polled so the "pending" panel stays current even when
  // the only change is a push acknowledgement (which trims, not adds, rows).
  pending: entry(always, {
    modelToDependencies: alwaysOn,
    dependenciesToStream: () =>
      Stream.tick(Duration.millis(750)).pipe(
        Stream.mapEffect(() => Effect.promise(() => getWorld().pendingNow())),
        Stream.map((pending) => PendingChanged({ pending }))
      ),
  }),

  // The simulated remote agent: only ticks while toggled on (deps drive it).
  remoteAgent: entry(
    { active: S.Boolean },
    {
      modelToDependencies: (model) => ({ active: model.remoteAgent }),
      dependenciesToStream: ({ active }) =>
        Stream.when(
          Stream.tick(Duration.seconds(4)).pipe(
            Stream.mapEffect(() => Effect.promise(() => getWorld().simulateRemote())),
            Stream.map(() => NoOp())
          ),
          Effect.sync(() => active)
        ),
    }
  ),
}));

// ─── View ────────────────────────────────────────────────────────────────────

const filterTodos = (todos: ReadonlyArray<Todo>, filter: Filter): ReadonlyArray<Todo> =>
  M.value(filter).pipe(
    M.when("All", () => todos),
    M.when("Active", () => todos.filter((todo) => !todo.done)),
    M.when("Completed", () => todos.filter((todo) => todo.done)),
    M.exhaustive
  );

const connectionLabel = (status: typeof ConnectionStatus.Type): string =>
  M.value(status).pipe(
    M.when("connected", () => "online"),
    M.when("disconnected", () => "offline"),
    M.when("connecting", () => "connecting…"),
    M.exhaustive
  );

export const view = (model: Model): Document => {
  const h = html<Message>();

  const total = model.todos.length;
  const active = model.todos.filter((todo) => !todo.done).length;
  const completed = total - active;
  const offline = model.connection === "disconnected";
  const visible = filterTodos(model.todos, model.filter);

  const statusBar = h.div(
    [h.Class("status-bar")],
    [
      h.span(
        [h.Class(`pill pill-${model.connection}`)],
        [`● ${connectionLabel(model.connection)}`]
      ),
      h.span(
        [h.Class(model.pending.length > 0 ? "pill pill-pending" : "pill pill-clean")],
        [model.pending.length > 0 ? `${model.pending.length} pending` : "all synced"]
      ),
      h.span(
        [h.Class("muted")],
        [model.lastSyncAt === null ? "" : `last sync ${new Date(model.lastSyncAt).toLocaleTimeString()}`]
      ),
    ]
  );

  const controls = h.div(
    [h.Class("controls")],
    [
      h.button(
        [h.Class(offline ? "btn btn-warn" : "btn"), h.OnClick(ToggledConnection())],
        [offline ? "Go online" : "Go offline"]
      ),
      h.button([h.Class("btn"), h.OnClick(ClickedSyncNow())], ["Sync now"]),
      h.button([h.Class("btn"), h.OnClick(ClickedSimulateRemote())], ["Remote edit"]),
      h.button(
        [h.Class(model.remoteAgent ? "btn btn-active" : "btn"), h.OnClick(ToggledRemoteAgent())],
        [model.remoteAgent ? "Remote agent: on" : "Remote agent: off"]
      ),
    ]
  );

  const addForm = h.form(
    [h.Class("add-form"), h.OnSubmit(SubmittedDraft())],
    [
      h.input([
        h.Class("add-input"),
        h.Value(model.draft),
        h.Placeholder(offline ? "Offline — writes will queue" : "What needs doing?"),
        h.OnInput((text) => UpdatedDraft({ text })),
      ]),
      h.button([h.Class("btn btn-primary"), h.Type("submit")], ["Add"]),
    ]
  );

  const filterTab = (filter: Filter): Html =>
    h.button(
      [
        h.Class(model.filter === filter ? "tab tab-active" : "tab"),
        h.OnClick(SelectedFilter({ filter })),
      ],
      [filter]
    );

  const tabs = h.div([h.Class("tabs")], [filterTab("All"), filterTab("Active"), filterTab("Completed")]);

  const todoItem = (todo: Todo): Html =>
    h.li(
      [h.Class(todo.done ? "todo todo-done" : "todo")],
      [
        h.label(
          [h.Class("todo-main")],
          [
            h.input([h.Type("checkbox"), h.Checked(todo.done), h.OnClick(ToggledTodo({ id: todo.id }))]),
            h.span([h.Class("todo-title")], [todo.title]),
          ]
        ),
        h.button([h.Class("link link-danger"), h.OnClick(DeletedTodo({ id: todo.id }))], ["delete"]),
      ]
    );

  const list =
    visible.length === 0
      ? h.div([h.Class("empty")], ["Nothing here yet."])
      : h.ul([h.Class("todo-list")], visible.map(todoItem));

  const journal =
    model.pending.length === 0
      ? h.div([h.Class("journal journal-empty")], ["Journal empty — every write is confirmed."])
      : h.div(
          [h.Class("journal")],
          [
            h.div([h.Class("journal-title")], ["Pending journal (optimistic, unconfirmed)"]),
            h.ul(
              [h.Class("journal-list")],
              model.pending.map((entry) =>
                h.li([h.Class("journal-row")], [`#${entry.mutationId}`, " ", entry.summary])
              )
            ),
          ]
        );

  const footer = h.div(
    [h.Class("footer")],
    [
      h.span([], [`${active} active · ${completed} completed · ${total} total`]),
      completed > 0
        ? h.button([h.Class("link"), h.OnClick(ClearedCompleted())], ["clear completed"])
        : h.span([h.Class("muted")], ["—"]),
    ]
  );

  const body = h.div(
    [h.Class("app")],
    [
      h.div(
        [h.Class("card")],
        [
          h.h1([h.Class("title")], ["effect-sync · FoldKit"]),
          h.p([h.Class("subtitle")], ["Offline-first todos: optimistic writes, live views, push/pull rebase."]),
          statusBar,
          controls,
          addForm,
          tabs,
          list,
          footer,
          journal,
        ]
      ),
    ]
  );

  return { title: `Todos (${active})`, body };
};
