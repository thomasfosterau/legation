/**
 * The read-thunk opt-out (#141): every rune hook that takes a read thunk
 * (`useQuery`, `useConnection`, `useNamedQuery`, `useAggregate`,
 * `useAggregateGrouped`) treats `undefined` as "no read right now". No
 * window is registered and no request is issued, and the hook's `current`
 * stays at its initial state — distinguishable from a `Success` over zero
 * rows — until the thunk starts returning a read again.
 *
 * Assertions go through `engine.activeSubscriptions` (the ledger) and
 * recorded `transport.pull` requests, never the rendered DOM alone: a test
 * that only checks the DOM would pass while the window stayed registered,
 * which is the entire bug (#141's northwind/realworld `?? ""` sentinels).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import OptOutQueryHarness from "./fixtures/OptOutQueryHarness.svelte";
import OptOutConnectionHarness from "./fixtures/OptOutConnectionHarness.svelte";
import OptOutNamedQueryHarness from "./fixtures/OptOutNamedQueryHarness.svelte";
import OptOutAggregateHarness from "./fixtures/OptOutAggregateHarness.svelte";
import {
  buttonByLabel,
  makeClientRuntime,
  makeCountingClientRuntime,
  run,
  until,
  untilSubscriptions,
} from "./world.js";

const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("read-thunk opt-out (#141)", () => {
  it("useQuery: undefined registers no window and issues no request; Initial is distinguishable from an empty Success", async () => {
    const { runtime, pulls } = makeCountingClientRuntime();
    // A row that WOULD match once subscribed — proves the opted-out hook
    // really issues no request, not merely that it doesn't render this row.
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "1", title: "match" }));

    const app = mount(OptOutQueryHarness, { target: document.body, props: { runtime } });

    await until(() => text().includes("state:Initial"));
    expect(text()).not.toContain("row:match");
    expect(await run(runtime, (engine) => engine.activeSubscriptions)).toHaveLength(0);

    // Drive a pull explicitly: its request carries no subscriptions, so the
    // opted-out read never rode along on the wire.
    await run(runtime, (engine) => engine.pull);
    expect(pulls.at(-1)?.subscriptions).toHaveLength(0);

    // Flip on: the window registers, the row arrives, and the result is a
    // genuine Success — never the Initial state opting out leaves behind.
    buttonByLabel("select").click();
    await until(() => text().includes("row:match"));
    expect(text()).toContain("state:Success");
    expect(text()).not.toContain(":waiting");
    expect(await run(runtime, (engine) => engine.activeSubscriptions)).toHaveLength(1);

    await run(runtime, (engine) => engine.pull);
    expect(pulls.at(-1)?.subscriptions).toHaveLength(1);

    // Flip back off: the window deregisters and `current` returns to
    // Initial — not a stale Success left waiting forever.
    buttonByLabel("clear").click();
    await until(() => text().includes("state:Initial"));
    expect(text()).not.toContain("row:match");
    await untilSubscriptions(runtime, (n) => n === 0);

    await run(runtime, (engine) => engine.pull);
    expect(pulls.at(-1)?.subscriptions).toHaveLength(0);

    unmount(app);
    await runtime.dispose();
  });

  it("useConnection: undefined registers no window; selecting a parent subscribes and pages it", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "t1", title: "a-1", authorId: "u1" })
    );

    const app = mount(OptOutConnectionHarness, { target: document.body, props: { runtime } });

    await until(() => text().includes("state:Initial"));
    expect(text()).not.toContain("row:a-1");
    expect(text()).toContain("hasMore:false");
    expect(await run(runtime, (engine) => engine.activeSubscriptions)).toHaveLength(0);

    buttonByLabel("select").click();
    await until(() => text().includes("row:a-1"));
    expect(text()).toContain("state:Success");
    await untilSubscriptions(runtime, (n) => n >= 1);

    buttonByLabel("clear").click();
    await until(() => text().includes("state:Initial"));
    expect(text()).not.toContain("row:a-1");
    await untilSubscriptions(runtime, (n) => n === 0);

    unmount(app);
    await runtime.dispose();
  });

  // `useNamedQuery` reads via `client.view.observeNamed` — the local-tier
  // view straight to the engine, never through `Client.observe`'s ledger —
  // so there is no window to assert against the way `useQuery` has. What's
  // testable, and what the fix must still get right here, is that opting
  // out never resolves the named query at all: `current` stays `Initial`,
  // distinguishable from the `Success` a matching name/args resolves to.
  it("useNamedQuery: undefined never resolves the named query; current stays Initial", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "1", title: "match" }));
    await run(runtime, (engine) => engine.mutate("todo/set", { id: "2", title: "other" }));

    const app = mount(OptOutNamedQueryHarness, { target: document.body, props: { runtime } });

    await until(() => text().includes("state:Initial"));
    expect(text()).not.toContain("row:match");

    buttonByLabel("select").click();
    await until(() => text().includes("row:match"));
    expect(text()).not.toContain("row:other");
    expect(text()).toContain("state:Success");

    buttonByLabel("clear").click();
    await until(() => text().includes("state:Initial"));
    expect(text()).not.toContain("row:match");

    unmount(app);
    await runtime.dispose();
  });

  // `useAggregate`/`useAggregateGrouped` are local-tier too (CONTEXT.md:
  // "the aggregate sees the rows this client has synced") — they read via
  // `client.view.observe` directly, not `Client.observe`'s ledger, so
  // there is no window registration to assert here either. The fix's
  // testable surface is the same as above: `current` stays `Initial`
  // while opted out rather than resolving to a (mis)count of zero.
  it("useAggregate / useAggregateGrouped: undefined never resolves; current stays Initial for both", async () => {
    const runtime = makeClientRuntime();
    await run(runtime, (engine) =>
      engine.mutate("todo/set", { id: "t1", title: "a-1", authorId: "u1" })
    );

    const app = mount(OptOutAggregateHarness, { target: document.body, props: { runtime } });

    await until(() => text().includes("count-state:Initial"));
    expect(text()).toContain("grouped-state:Initial");
    expect(text()).toContain("count:none");

    buttonByLabel("select").click();
    await until(() => text().includes("count:1"));
    expect(text()).toContain("count-state:Success");
    expect(text()).toContain("grouped-state:Success");
    expect(text()).toContain('"u1":1');

    buttonByLabel("clear").click();
    await until(() => text().includes("count-state:Initial"));
    expect(text()).toContain("grouped-state:Initial");
    expect(text()).toContain("count:none");

    unmount(app);
    await runtime.dispose();
  });
});
