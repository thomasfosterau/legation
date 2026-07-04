// @vitest-environment jsdom
/**
 * React hooks against a real engine (in-memory backend) under jsdom: useQuery
 * renders live results (an AsyncResult) and re-renders when a mutation lands;
 * useMutation drives an optimistic write from a click. Everything runs over an
 * AtomRegistry — the hooks are a thin layer over the engine's atoms.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import * as React from "react";
import { Effect, Layer, Schema } from "effect";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@legation/effect";
import { ClientEngine, EngineAtoms, Subset, SyncRoom } from "@legation/effect/internal";
import { EffectSyncProvider, useMutation, useMutationWithAck, useQuery } from "../index.js";

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

const TodoList = () => {
  const result = useQuery(allTodos);
  const rows = AsyncResult.getOrElse(result, () => [] as ReadonlyArray<ClientEngine.LocalRow>);
  return React.createElement(
    "ul",
    null,
    rows.map((row) => React.createElement("li", { key: row.id }, title(row)))
  );
};

const AddButton = () => {
  const mutate = useMutation();
  return React.createElement(
    "button",
    { onClick: () => mutate("todo/set", { id: "2", title: "added" }) },
    "add"
  );
};

const AckButton = (props: {
  readonly onOutcome: (outcome: ClientEngine.MutationOutcome) => void;
}) => {
  const mutateWithAck = useMutationWithAck();
  return React.createElement(
    "button",
    {
      onClick: () => {
        void mutateWithAck("todo/set", { id: "3", title: "awaited" }).then(props.onOutcome);
      },
    },
    "ack"
  );
};

afterEach(cleanup);

describe("React hooks", () => {
  it("renders live query results and updates on mutation", async () => {
    const atoms = EngineAtoms.fromLayer(engineLayer);
    const registry = AtomRegistry.make();
    render(
      React.createElement(
        EffectSyncProvider,
        { atoms, registry },
        React.createElement(TodoList),
        React.createElement(AddButton)
      )
    );

    expect(screen.queryByText("seed")).toBeNull();

    // Seed by writing the mutation atom — the same atom-native path the button uses.
    await act(async () => {
      registry.set(atoms.mutation, { mutator: "todo/set", args: { id: "1", title: "seed" } });
    });
    await waitFor(() => expect(screen.getByText("seed")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("add"));
    });
    await waitFor(() => expect(screen.getByText("added")).toBeTruthy());

    registry.dispose();
  });

  it("useMutationWithAck resolves with the backend outcome", async () => {
    const atoms = EngineAtoms.fromLayer(engineLayer);
    const registry = AtomRegistry.make();
    // A push atom to drive the acknowledgement that settles the outcome.
    const pushAtom = atoms.runtime.fn(() =>
      Effect.flatMap(ClientEngine.ClientEngine, (engine) => engine.push)
    );
    let outcome: ClientEngine.MutationOutcome | undefined;
    render(
      React.createElement(
        EffectSyncProvider,
        { atoms, registry },
        React.createElement(TodoList),
        React.createElement(AckButton, { onOutcome: (value) => (outcome = value) })
      )
    );

    await act(async () => {
      fireEvent.click(screen.getByText("ack"));
    });
    // The optimistic write lands (and the ack is registered) before the push.
    await waitFor(() => expect(screen.getByText("awaited")).toBeTruthy());

    await act(async () => {
      registry.set(pushAtom, undefined);
    });
    await waitFor(() => expect(outcome).toEqual({ _tag: "applied" }));

    registry.dispose();
  });
});
