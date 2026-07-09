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
import { Effect, Layer, Schema, Stream } from "effect";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Predicate,
  Transport,
} from "@legation/effect";
import { ClientEngine, EngineAtoms, Subset, SyncRoom } from "@legation/effect/internal";
import {
  EffectSyncProvider,
  useMutation,
  useMutationState,
  useMutationWithAck,
  useQuery,
} from "../index.js";

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
const matchTodos = Subset.make({ collection: "todos", where: Predicate.eq("title", "match") });
const otherTodos = Subset.make({ collection: "todos", where: Predicate.eq("title", "other") });
const title = (row: { readonly value: unknown }) => (row.value as { title: string }).title;

/**
 * A `ClientEngine` stub whose `observe` answers `matchTodos` immediately but
 * blocks `otherTodos` on `gate.current` until released. The real in-memory
 * engine resolves a brand new subset's first pull synchronously (no genuine
 * `await` boundary — the local replica already has the matching rows), so
 * there's no way to observe the transient `Initial` a changed-subset atom
 * starts at without an engine that can be told to stay pending.
 */
const makeSwitchableEngineLayer = (gate: {
  current: Promise<void> | undefined;
}): Layer.Layer<ClientEngine.ClientEngine> =>
  Layer.succeed(ClientEngine.ClientEngine)({
    observe: ((subset: Subset.Subset) =>
      Subset.hash(subset) === Subset.hash(otherTodos)
        ? Stream.unwrap(
            Effect.as(
              Effect.promise(() => gate.current ?? Promise.resolve()),
              Stream.succeed([{ id: "2", value: { id: "2", title: "other" } }])
            )
          )
        : Stream.succeed([
            { id: "1", value: { id: "1", title: "match" } },
          ])) as ClientEngine.ClientEngine["observe"],
  } as ClientEngine.ClientEngine);

const TodoList = () => {
  const result = useQuery(allTodos);
  const rows = AsyncResult.getOrElse(result, () => [] as ReadonlyArray<ClientEngine.LocalRow>);
  return React.createElement(
    "ul",
    null,
    rows.map((row) => React.createElement("li", { key: row.id }, title(row)))
  );
};

const SwitchableList = () => {
  const [which, setWhich] = React.useState<"match" | "other">("match");
  const result = useQuery(which === "match" ? matchTodos : otherTodos, { keepPrevious: true });
  const rows = AsyncResult.getOrElse(result, () => [] as ReadonlyArray<ClientEngine.LocalRow>);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("button", { onClick: () => setWhich("other") }, "switch"),
    React.createElement("p", null, `state:${result._tag}${result.waiting ? ":waiting" : ""}`),
    React.createElement(
      "ul",
      null,
      rows.map((row) => React.createElement("li", { key: row.id }, title(row)))
    )
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

const JournalPanel = () => {
  const all = useMutationState();
  const forSetTodo = useMutationState("todo/set");
  return React.createElement(
    "ul",
    null,
    all.map((state) =>
      React.createElement(
        "li",
        { key: state.mutationId },
        `#${state.mutationId} ${state.phase} (${forSetTodo.length} for todo/set)`
      )
    )
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

  it("keepPrevious keeps the previous subset's rows as a waiting Success across a subset change", async () => {
    let releaseOther: (() => void) | undefined;
    const gate: { current: Promise<void> | undefined } = {
      current: new Promise((resolve) => {
        releaseOther = resolve;
      }),
    };
    const atoms = EngineAtoms.fromLayer(makeSwitchableEngineLayer(gate));
    const registry = AtomRegistry.make();
    render(
      React.createElement(
        EffectSyncProvider,
        { atoms, registry },
        React.createElement(SwitchableList)
      )
    );

    await waitFor(() => expect(screen.getByText("match")).toBeTruthy());
    expect(screen.getByText("state:Success")).toBeTruthy();

    // Switch to the "other" subset: the click's synchronous re-render must
    // show the previous ("match") row still, tagged waiting, never an empty
    // flash, even though the new subset's atom is still `Initial` (its
    // stream is gated on `releaseOther`).
    fireEvent.click(screen.getByText("switch"));
    expect(screen.getByText("match")).toBeTruthy();
    expect(screen.getByText("state:Success:waiting")).toBeTruthy();

    // Release the gate: the new subset's first emission replaces it with
    // fresh (non-waiting) rows.
    await act(async () => {
      releaseOther?.();
    });
    await waitFor(() => expect(screen.getByText("other")).toBeTruthy());
    expect(screen.queryByText("match")).toBeNull();
    expect(screen.getByText("state:Success")).toBeTruthy();

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

  it("useMutationState (#116) reflects pending then acknowledged, whole map and per-mutator", async () => {
    const atoms = EngineAtoms.fromLayer(engineLayer);
    const registry = AtomRegistry.make();
    const pushAtom = atoms.runtime.fn(() =>
      Effect.flatMap(ClientEngine.ClientEngine, (engine) => engine.push)
    );
    render(
      React.createElement(
        EffectSyncProvider,
        { atoms, registry },
        React.createElement(JournalPanel),
        React.createElement(AddButton)
      )
    );

    expect(screen.queryByText(/#\d/)).toBeNull();

    // A plain `mutate` (not `mutateWithAck`) must still be tracked — #116
    // fixes a gap where only `mutateWithAck`-registered mutations settled.
    await act(async () => {
      fireEvent.click(screen.getByText("add"));
    });
    await waitFor(() => expect(screen.getByText("#1 pending (1 for todo/set)")).toBeTruthy());

    await act(async () => {
      registry.set(pushAtom, undefined);
    });
    await waitFor(() => expect(screen.getByText("#1 acknowledged (1 for todo/set)")).toBeTruthy());

    registry.dispose();
  });
});
