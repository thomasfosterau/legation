/**
 * The shared forgetting bound for rejection memory (#355): the per-client floors
 * a push carries, and the rejections below each floor that are forgotten. The
 * backends' own tests cover this end to end; these cover the module's edges.
 */
import { describe, expect, it } from "vite-plus/test";
import * as RejectionMemory from "../RejectionMemory.js";

describe("RejectionMemory.floorsOf", () => {
  it("takes the lowest mutation id per client", () => {
    const floors = RejectionMemory.floorsOf([
      { clientId: "a", mutationId: 7 },
      { clientId: "b", mutationId: 3 },
      { clientId: "a", mutationId: 5 },
      { clientId: "a", mutationId: 9 },
    ]);
    expect([...floors]).toEqual([
      ["a", 5],
      ["b", 3],
    ]);
  });

  it("is empty for a push with no mutations", () => {
    expect(RejectionMemory.floorsOf([]).size).toBe(0);
  });
});

describe("RejectionMemory.forgetBelow", () => {
  const rejections = new Map([
    [
      "a",
      new Map([
        [1, "x"],
        [2, "y"],
        [5, "z"],
      ]),
    ],
    ["b", new Map([[4, "w"]])],
  ]);

  it("drops a client's rejections below its floor and keeps the rest", () => {
    const kept = RejectionMemory.forgetBelow(rejections, new Map([["a", 2]]));
    expect(kept).not.toBe(rejections);
    expect([...(kept.get("a") ?? [])]).toEqual([
      [2, "y"],
      [5, "z"],
    ]);
    expect(kept.get("b")).toBe(rejections.get("b"));
  });

  it("keeps a rejection exactly at the floor", () => {
    const kept = RejectionMemory.forgetBelow(rejections, new Map([["b", 4]]));
    expect(kept.get("b")?.get(4)).toBe("w");
  });

  it("removes a client whose rejections are all below its floor", () => {
    const kept = RejectionMemory.forgetBelow(rejections, new Map([["b", 5]]));
    expect(kept.has("b")).toBe(false);
    expect(kept.get("a")).toBe(rejections.get("a"));
  });

  it("returns the same map when nothing is forgotten", () => {
    expect(RejectionMemory.forgetBelow(rejections, new Map([["a", 1]]))).toBe(rejections);
    expect(RejectionMemory.forgetBelow(rejections, new Map([["unknown", 99]]))).toBe(rejections);
    expect(RejectionMemory.forgetBelow(rejections, new Map())).toBe(rejections);
  });

  it("does not mutate the map it was given", () => {
    RejectionMemory.forgetBelow(rejections, new Map([["a", 5]]));
    expect(rejections.get("a")?.size).toBe(3);
    expect(rejections.has("b")).toBe(true);
  });
});
