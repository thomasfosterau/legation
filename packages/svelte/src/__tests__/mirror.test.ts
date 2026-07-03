/**
 * The same components over a service-worker-shaped deployment (ADR-0021):
 * the runtime's ClientView is a TabMirror talking to an EngineHost over a
 * loopback channel — no ClientEngine in the runtime at all. `query`,
 * `aggregate` (derived over the view), and `getMutate` behave identically to
 * the main-thread engine, proving TabMirror satisfies the ClientView surface
 * structurally.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ClientEngine, ClientView, Subset } from "@legation/effect";
import { EngineHost, MirrorChannel, TabMirror } from "@legation/effect";
import QueryHarness from "./fixtures/QueryHarness.svelte";
import MutateHarness from "./fixtures/MutateHarness.svelte";
import RunesRelatedHarness from "./fixtures/RunesRelatedHarness.svelte";
import { buttonByLabel, collections, engineLayer, mutators, until } from "./world.js";
import type { EffectSyncRuntime } from "../Runtime.js";

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
        // TabMirror satisfies ClientView structurally — this return is the
        // type-level proof.
        return yield* TabMirror.make({ channel: pair.tab, mutators });
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

  it("useRelated({ subscribe: true }) joins over a mirror-only runtime (host-resolved)", async () => {
    const runtime = makeMirrorRuntime();
    // Seed through the mirror: an author and a todo pointing at them.
    await runtime.runPromise(
      Effect.flatMap(ClientView.ClientView, (view) =>
        Effect.andThen(
          view.mutate("user/set", { id: "u1", name: "Ada" }),
          view.mutate("todo/set", { id: "1", title: "join", authorId: "u1" })
        )
      )
    );

    const harness = mount(RunesRelatedHarness, {
      target: document.body,
      props: {
        runtime,
        registry: collections,
        collection: "todos",
        subset: allTodos,
        names: ["author"],
        subscribe: true,
      },
    });

    // The host runs the reconcile loop AND the join; the tab renders the
    // resolved rows it receives — no engine in this runtime at all.
    await until(() => text().includes("join:Ada"));
    expect(text()).toContain("join:Ada");

    unmount(harness);
    await runtime.dispose();
  });
});
