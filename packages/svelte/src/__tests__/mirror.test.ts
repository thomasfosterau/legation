/**
 * The same components over a service-worker-shaped deployment (ADR-0021):
 * the runtime's ClientView is a Mirror talking to an EngineHost over a
 * loopback channel — no ClientEngine in the runtime at all. `query`,
 * `aggregate` (derived over the view), and `getMutate` behave identically to
 * the main-thread engine, proving Mirror satisfies the ClientView surface
 * structurally.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Client } from "@legation/effect";
import { ClientEngine, ClientView, Subset } from "@legation/effect/internal";
import { EngineHost, MirrorChannel, Mirror } from "@legation/effect/internal";
import QueryHarness from "./fixtures/QueryHarness.svelte";
import MutateHarness from "./fixtures/MutateHarness.svelte";
import RunesRelatedHarness from "./fixtures/RunesRelatedHarness.svelte";
import { buttonByLabel, collections, engineLayer, mutators, nodes, until } from "./world.js";
import type { ClientRuntime, EffectSyncRuntime } from "../Runtime.js";

const allTodos = Subset.make({ collection: "todos" });
const text = () => document.body.textContent ?? "";

/**
 * A mirror-only runtime: the host engine and its channel live inside the
 * layer's scope; the runtime exposes ONLY the ClientView (the mirror).
 */
const makeMirrorRuntime = (): EffectSyncRuntime =>
  ManagedRuntime.make(
    Layer.effect(ClientView.ClientView)(
      Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        const pair = yield* MirrorChannel.makeLoopbackPair;
        // Wires its inbox eagerly and forks its own scoped loop — must run
        // before the mirror posts its first message. The registry lets the
        // host resolve tabs' `related` registrations.
        yield* EngineHost.run({ channel: pair.host, engine, registry: collections });
        // Mirror satisfies ClientView structurally — this return is the
        // type-level proof.
        return yield* Mirror.make({ channel: pair.mirror, mutators });
      })
    ).pipe(Layer.provide(engineLayer))
  );

afterEach(() => {
  document.body.innerHTML = "";
});

describe("bindings over a tab mirror (ADR-0021)", () => {
  it("query, aggregate and mutate drive the same components over a mirror-only runtime", async () => {
    const runtime = makeMirrorRuntime();
    // The app registers the subsets it needs — refcounted by the host.
    await runtime.runPromise(
      Effect.flatMap(ClientView.ClientView, (view) => view.subscribe(allTodos))
    );

    const list = mount(QueryHarness, {
      target: document.body,
      props: { runtime, subset: allTodos, groupBy: "authorId" },
    });
    const buttons = mount(MutateHarness, {
      target: document.body,
      props: { runtime, onOutcome: () => {} },
    });

    await until(() => text().includes("count:0"));
    expect(text()).not.toContain("added");

    // Mutate through the mirror: forwarded to the host engine, applied
    // optimistically, broadcast back — the component re-renders.
    buttonByLabel("add").click();
    await until(() => text().includes("added"));
    await until(() => text().includes("count:1"));

    unmount(buttons);
    unmount(list);
    await runtime.dispose();
  });

  it("an include join over a mirror-only Client resolves host-side", async () => {
    // A Client over the mirror alone — no engine in this runtime at all.
    const runtime: ClientRuntime = ManagedRuntime.make(
      Layer.effect(Client.Client)(
        Effect.gen(function* () {
          const engine = yield* ClientEngine.ClientEngine;
          const pair = yield* MirrorChannel.makeLoopbackPair;
          yield* EngineHost.run({ channel: pair.host, engine, registry: collections });
          const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
          return Client.fromView(nodes, mirror);
        })
      ).pipe(Layer.provide(engineLayer))
    );
    // Seed through the Client: an author and a todo pointing at them.
    await runtime.runPromise(
      Effect.flatMap(Client.Client, (client) =>
        Effect.andThen(
          client.mutate("user/set", { id: "u1", name: "Ada" }),
          client.mutate("todo/set", { id: "1", title: "join", authorId: "u1" })
        )
      )
    );

    const harness = mount(RunesRelatedHarness, {
      target: document.body,
      props: { runtime, read: { collection: "todos", include: { author: true } } },
    });

    // The host runs the reconcile loop AND the join; the tab renders the
    // resolved rows it receives.
    await until(() => text().includes("join:Ada"));
    expect(text()).toContain("join:Ada");

    unmount(harness);
    await runtime.dispose();
  });
});
