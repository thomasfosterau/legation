import { describe, expect, it } from "vitest";
import { Facade } from "@thomasfosterau/effect-sync-client";

describe("Facade.makeClient", () => {
  it("fetches via a promise loader and caches", async () => {
    const client = Facade.makeClient();
    let runs = 0;
    const loader = () => {
      runs += 1;
      return Promise.resolve({ name: "Ada" });
    };
    try {
      const first = await client.fetch(["users", "1"], loader, { staleTimeMillis: 60_000 });
      const second = await client.fetch(["users", "1"], loader, { staleTimeMillis: 60_000 });
      expect(first).toEqual({ name: "Ada" });
      expect(second).toEqual({ name: "Ada" });
      expect(runs).toBe(1);
    } finally {
      await client.dispose();
    }
  });

  it("getQueryData / setQueryData round-trip", async () => {
    const client = Facade.makeClient();
    try {
      await client.setQueryData(["users", "1"], { name: "Grace" });
      const data = await client.getQueryData<{ name: string }>(["users", "1"]);
      expect(data).toEqual({ name: "Grace" });
    } finally {
      await client.dispose();
    }
  });

  it("mutate runs the mutator and returns its result", async () => {
    const client = Facade.makeClient();
    try {
      const result = await client.mutate(
        ["users", "1"],
        (input: { name: string }) => Promise.resolve({ ...input, saved: true }),
        { name: "Ada" }
      );
      expect(result).toEqual({ name: "Ada", saved: true });
    } finally {
      await client.dispose();
    }
  });

  it("subscribe delivers query states to callbacks", async () => {
    const client = Facade.makeClient();
    try {
      const states = await new Promise<ReadonlyArray<string>>((resolve) => {
        const collected: Array<string> = [];
        const unsubscribe = client.subscribe(
          ["users", "1"],
          () => Promise.resolve({ name: "Ada" }),
          {
            onState: (state) => {
              collected.push(state.status);
              if (state.status === "success") {
                unsubscribe();
                // Give the unsubscribe a tick, then resolve.
                setTimeout(() => resolve(collected), 10);
              }
            },
          },
          { staleTimeMillis: 60_000 }
        );
      });
      expect(states[0]).toBe("loading");
      expect(states).toContain("success");
    } finally {
      await client.dispose();
    }
  });
});
