// @vitest-environment jsdom
/**
 * SSR hydration under jsdom (issue #41): an engine built over a store hydrated
 * from a snapshot renders its rows on the first commit — no loading/Initial
 * flash — and a subsequent pull patch re-renders with a row the client only
 * ever received from the server. The store carries the confirmed rows across
 * the serialisation boundary, so `useQuery`'s first value is already `Success`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import * as React from "react";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  Cvr,
  EngineAtoms,
  Hydration,
  InvalidationBus,
  MemoryBackend,
  Mutator,
  Subset,
  SyncServer,
  Transport,
} from "@legation/effect";
import { EffectSyncProvider, useQuery } from "../index.js";

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

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

// A snapshot as an SSR server would produce it: one confirmed row, no journal.
const snapshot: Hydration.Snapshot = {
  rows: [{ collection: "todos", id: "1", version: 1, value: { id: "1", title: "hydrated" } }],
  journal: [],
};

const allTodos = Subset.make({ collection: "todos" });
const title = (row: { readonly value: unknown }) => (row.value as { title: string }).title;

// Records the AsyncResult tag on every render, so the test can assert the first
// committed render already had data (no loading flash).
const TodoList = (props: { readonly tags: Array<string> }) => {
  const result = useQuery(allTodos);
  props.tags.push(result._tag);
  const rows = AsyncResult.getOrElse(result, () => [] as ReadonlyArray<ClientEngine.LocalRow>);
  return React.createElement(
    "ul",
    null,
    rows.map((row) => React.createElement("li", { key: row.id }, title(row)))
  );
};

// Build a shared server (a peer client commits a row to its backend), a hydrated
// browser store, and a transport for the browser onto that same server.
const setup = Effect.gen(function* () {
  const handler = yield* makeServer;
  const peerStore = yield* ClientStore.makeMemory;
  const peerTransport = yield* Transport.makeInMemory(handler, "group-1");
  const peer = yield* ClientEngine.make({
    clientId: "peer",
    clientGroupId: "group-1",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, peerStore),
    Effect.provideService(Transport.ClientTransport, peerTransport)
  );
  yield* peer.subscribe(allTodos);
  yield* peer.mutate("todo/set", { id: "2", title: "from-server" });
  yield* peer.push;

  const browserStore = yield* ClientStore.makeMemory;
  yield* Hydration.hydrate(browserStore, snapshot);
  const browserTransport = yield* Transport.makeInMemory(handler, "group-1");
  return { browserStore, browserTransport };
});

let scope: Scope.Closeable;
afterEach(async () => {
  cleanup();
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("SSR hydration (#41)", () => {
  it("renders hydrated rows on first paint with no loading flash, then a pull re-renders", async () => {
    scope = Effect.runSync(Scope.make());
    const { browserStore, browserTransport } = await Effect.runPromise(
      setup.pipe(Effect.provideService(Scope.Scope, scope))
    );

    const engineLayer = ClientEngine.layer({
      clientId: "browser",
      clientGroupId: "group-1",
      mutators,
    }).pipe(
      Layer.provide(Layer.succeed(Transport.ClientTransport)(browserTransport)),
      Layer.provide(Layer.succeed(ClientStore.ClientStore)(browserStore))
    );

    const atoms = EngineAtoms.fromLayer(engineLayer);
    const registry = AtomRegistry.make();
    const tags: Array<string> = [];

    render(
      React.createElement(
        EffectSyncProvider,
        { atoms, registry },
        React.createElement(TodoList, { tags })
      )
    );

    // The hydrated row is on screen from the first commit — no "loading" gap.
    expect(screen.getByText("hydrated")).toBeTruthy();
    // The very first render already carried a value (Success), never Initial.
    expect(tags[0]).toBe("Success");
    expect(tags.includes("Initial")).toBe(false);

    // A pull brings the peer's committed row — one the browser never had locally,
    // so the re-render is unambiguously pull-driven.
    const sync = atoms.runtime.fn(() =>
      Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
        engine.subscribe(allTodos).pipe(Effect.andThen(engine.pull))
      )
    );
    await act(async () => {
      registry.set(sync, undefined);
    });
    await waitFor(() => expect(screen.getByText("from-server")).toBeTruthy());
    // The hydrated row survives the pull (no reset), so both render.
    expect(screen.getByText("hydrated")).toBeTruthy();

    registry.dispose();
  });
});
