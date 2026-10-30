/**
 * Booting the bindings without an Effect runtime (#147): `createClient` takes
 * `Client.make`'s options and returns a handle with its own `dispose`, and
 * `setClient` puts it in context. With no Client (`setClient(undefined)`, as on
 * the server) a hook renders from its seed and fails only when it reaches for
 * the Client.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount, unmount } from "svelte";
import * as Effect from "effect/Effect";
import type { Query } from "@thomasfosterau/legation-effect";
import { Client } from "@thomasfosterau/legation-effect";
import { createClient } from "../index.svelte.js";
import ClientHarness from "./fixtures/ClientHarness.svelte";
import { mutators, nodes, until } from "./world.js";

const allTodos: Query.Read = { collection: "todos" };
const text = () => document.body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createClient (#147)", () => {
  it("boots a Client from plain options, live through the hooks, and disposes it", async () => {
    const client = createClient({ nodes, mutations: mutators });
    const harness = mount(ClientHarness, {
      target: document.body,
      props: { client, read: allTodos },
    });
    expect(text()).toContain("client:set");

    await client.runtime.runPromise(
      Effect.flatMap(Client.Client, (made) =>
        made.mutate("todo/set", { id: "1", title: "from a handle", authorId: "u1" })
      )
    );
    await until(() => text().includes("from a handle"));

    await unmount(harness);
    await client.dispose();
    // Disposing twice is harmless.
    await client.dispose();
  });

  it("with no Client, a hook that needs one fails with ClientUnavailable", async () => {
    const harness = mount(ClientHarness, {
      target: document.body,
      props: { client: undefined, read: allTodos },
    });
    expect(text()).toContain("client:none");
    await until(() => text().includes("failed:"));
    expect(text()).toContain("no Client here");
    await unmount(harness);
  });
});
