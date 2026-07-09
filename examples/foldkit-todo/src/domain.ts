/**
 * Domain
 *
 * The shared sync vocabulary, defined once and used on both sides of the
 * engine (CONTEXT.md): the `Todo` row schema is the single source of truth
 * for the collection, the `todo/set` mutator's args, and the FoldKit model.
 *
 * Mutators are *named, schema-validated write intents* executed twice — once
 * optimistically on the client and once authoritatively on the demo backend
 * (see `sync.ts`). The collection and subset are the units the engine
 * materializes and the live view observes.
 */

import { Schema } from "effect";
import { Collection, Mutator } from "@legation/effect";
import { Subset } from "@legation/effect/internal";

/** A todo row. Same schema drives the collection, the mutator args, and the UI. */
export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
  /** Client wall-clock at creation; gives the subset a stable sort key. */
  createdAt: Schema.Number,
});
export type Todo = typeof Todo.Type;

/** Args for the delete intent — just the row id. */
export const RemoveArgs = Schema.Struct({ id: Schema.String });
export type RemoveArgs = typeof RemoveArgs.Type;

/** The collection: a named, schema-typed set of rows keyed by id. */
export const todosCollection = Collection.make({
  name: "todos",
  schema: Todo,
  id: (todo) => todo.id,
});

/** Mutator contracts, shared by the client handlers and the demo backend. */
export const setTodo = Mutator.make("todo/set", Todo);
export const removeTodo = Mutator.make("todo/remove", RemoveArgs);

/**
 * The subset the engine subscribes to and the live view observes: every todo,
 * oldest first. A subset is the subscription unit of the protocol — the thing
 * the client registers, the server keeps synced, and the CVR tracks.
 */
export const allTodos = Subset.make({
  collection: "todos",
  orderBy: [{ field: "createdAt", direction: "asc" }],
});

/** This tab's client identity (per-client mutation sequencing) and group. */
export const CLIENT_ID = "foldkit-tab";
export const CLIENT_GROUP_ID = "foldkit-demo";
