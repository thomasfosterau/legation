/**
 * Domain
 *
 * The shared sync vocabulary, defined once and used on both sides of the
 * engine (CONTEXT.md), in ADR-0022's six concepts:
 *
 * - **Node** — the resource graph. One node here (`todos`); its attributes are
 *   the `Todo` schema minus the id the graph supplies.
 * - **Query** — the read. Declarative `Query.Read`s (collection, `where`,
 *   `order`); the Client compiles each into the sync windows it needs.
 * - **Mutation** — the write. Named, schema-validated intents executed twice:
 *   optimistically by the `local` handlers here, authoritatively by the demo
 *   backend (see `sync.ts`).
 */

import { Schema } from "effect";
import { Mutation, Node, type Query } from "@legation/effect";

/** A todo row. Same schema drives the node, the mutation args, and the UI. */
export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
  /** Client wall-clock at creation; gives the read a stable sort key. */
  createdAt: Schema.Number,
});
export type Todo = typeof Todo.Type;

/** Args for the delete intent — just the row id. */
export const RemoveArgs = Schema.Struct({ id: Schema.String });
export type RemoveArgs = typeof RemoveArgs.Type;

// ─── The node graph ──────────────────────────────────────────────────────────
//
// `Node.make` supplies the id, so the attributes are the rest of the schema.
// A one-node graph has no edges; `Node.registry` still validates it and
// derives the engine's collection registry from it.

const { id: _id, ...todoAttributes } = Todo.fields;

export const todos = Node.make("todos", { attributes: todoAttributes });

export const nodes = Node.registry([todos]);

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Every todo, oldest first — what the list observes. */
export const allTodos: Query.Read = { collection: "todos", order: ["createdAt"] };

/**
 * The incomplete todos. The footer's "active" count is a `Count` aggregate over
 * this read, so the tally is derived by the engine rather than an app-side
 * `.filter().length`.
 */
export const activeTodos: Query.Read = { collection: "todos", where: { done: false } };

// ─── Mutations ───────────────────────────────────────────────────────────────

export const setTodo = Mutation.make("todo/set", Todo);
export const removeTodo = Mutation.make("todo/remove", RemoveArgs);

/**
 * The client's optimistic handlers. They run once when the mutation is issued
 * and again on every rebase, so they must be idempotent — a `put` keyed by id
 * is.
 */
export const mutations = Mutation.registry([
  { mutator: setTodo, local: (todo, writer) => writer.put("todos", todo.id, todo) },
  { mutator: removeTodo, local: (args, writer) => writer.del("todos", args.id) },
]);

/** This tab's client identity (per-client mutation sequencing) and group. */
export const CLIENT_ID = "todo-tab";
export const CLIENT_GROUP_ID = "todo-demo";
