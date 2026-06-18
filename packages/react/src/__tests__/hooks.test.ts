// @vitest-environment jsdom
/**
 * React hooks against a real engine (in-memory backend) under jsdom: useQuery
 * renders live results and re-renders when a mutation lands; useMutation drives
 * an optimistic write from a click.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import * as React from "react";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  MemoryBackend,
  Mutator,
  Subset,
  SyncRoom,
  Transport,
} from "@thomasfosterau/effect-sync-core";
import { EffectSyncProvider, useMutation, useQuery } from "../index.js";

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
  },
]);
const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) =>
    Effect.asVoid(writer.put("todos", (args as { id: string }).id, args)),
};

const engineLayer = ClientEngine.layer({
  clientId: "c1",
  clientGroupId: "group-1",
  mutators,
}).pipe(
  Layer.provide(
    Transport.layerInMemory("group-1").pipe(
      Layer.provide(
        SyncRoom.layer.pipe(
          Layer.provide(Layer.effect(Backend.Backend)(MemoryBackend.make(handlers))),
          Layer.provide(
            Layer.succeed(Authorization.AuthPolicy)(
              Authorization.policy({ todos: Authorization.allowAll })
            )
          )
        )
      )
    )
  ),
  Layer.provide(ClientStore.layerMemory)
);

const allTodos = Subset.make({ collection: "todos" });
const title = (row: { readonly value: unknown }) => (row.value as { title: string }).title;

const TodoList = () =>
  React.createElement(
    "ul",
    null,
    useQuery(allTodos).map((row) => React.createElement("li", { key: row.id }, title(row)))
  );

const AddButton = () => {
  const mutate = useMutation();
  return React.createElement(
    "button",
    { onClick: () => void mutate("todo/set", { id: "2", title: "added" }) },
    "add"
  );
};

afterEach(cleanup);

describe("React hooks", () => {
  it("renders live query results and updates on mutation", async () => {
    const runtime = ManagedRuntime.make(engineLayer);
    render(
      React.createElement(
        EffectSyncProvider,
        { runtime },
        React.createElement(TodoList),
        React.createElement(AddButton)
      )
    );

    expect(screen.queryByText("seed")).toBeNull();

    await act(async () => {
      await runtime.runPromise(
        Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
          engine.mutate("todo/set", { id: "1", title: "seed" })
        )
      );
    });
    await waitFor(() => expect(screen.getByText("seed")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("add"));
    });
    await waitFor(() => expect(screen.getByText("added")).toBeTruthy());

    await runtime.dispose();
  });
});
