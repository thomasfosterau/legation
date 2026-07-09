/**
 * MutationState (#116): the pure fold — seed from the journal, fold
 * `journaled`/`acknowledged`/`rejected` transitions, and bound terminal
 * retention so a mutation storm cannot grow the map without limit.
 */
import { describe, expect, it } from "@effect/vitest";
import * as MutationState from "../MutationState.js";
import type { Mutation } from "../Protocol.js";

const mutation = (mutationId: number, mutator = "todo/set"): Mutation => ({
  clientId: "c1",
  mutationId,
  mutator,
  args: { id: String(mutationId) },
  createdAt: 1000 + mutationId,
});

describe("MutationState (#116)", () => {
  it("seed reflects every pending journal entry as pending", () => {
    const map = MutationState.seed([mutation(1), mutation(2, "todo/remove")]);
    expect(map.size).toBe(2);
    expect(map.get(1)).toEqual({
      mutationId: 1,
      mutator: "todo/set",
      args: { id: "1" },
      phase: "pending",
      journaledAt: 1001,
    });
    expect(map.get(2)?.mutator).toBe("todo/remove");
    expect(map.get(2)?.phase).toBe("pending");
  });

  it("journaled adds a fresh pending entry", () => {
    const map = MutationState.journaled(new Map(), {
      mutationId: 5,
      mutator: "todo/set",
      args: { id: "5" },
      journaledAt: 42,
    });
    expect(map.get(5)).toEqual({
      mutationId: 5,
      mutator: "todo/set",
      args: { id: "5" },
      phase: "pending",
      journaledAt: 42,
    });
  });

  it("acknowledged transitions pending to acknowledged with a settledAt", () => {
    const seeded = MutationState.seed([mutation(1)]);
    const next = MutationState.acknowledged(seeded, 1, 2000);
    expect(next.get(1)).toEqual({
      mutationId: 1,
      mutator: "todo/set",
      args: { id: "1" },
      phase: "acknowledged",
      journaledAt: 1001,
      settledAt: 2000,
    });
  });

  it("rejected transitions pending to rejected with a reason", () => {
    const seeded = MutationState.seed([mutation(1)]);
    const next = MutationState.rejected(seeded, 1, "permission revoked", 2000);
    expect(next.get(1)?.phase).toBe("rejected");
    expect(next.get(1)?.reason).toBe("permission revoked");
    expect(next.get(1)?.settledAt).toBe(2000);
  });

  it("settling an untracked mutationId is a no-op (nothing to fold)", () => {
    const map = MutationState.seed([]);
    expect(MutationState.acknowledged(map, 999, 1)).toBe(map);
    expect(MutationState.rejected(map, 999, "x", 1)).toBe(map);
  });

  it("retains pending entries regardless of the terminal bound", () => {
    let map = MutationState.seed([mutation(1), mutation(2), mutation(3)]);
    // Bound of 0 terminal entries — every pending stays, since eviction only
    // ever touches terminal (acknowledged/rejected) entries.
    map = MutationState.acknowledged(map, 1, 10, { maxTerminal: 0 });
    expect(map.has(1)).toBe(false); // the only terminal entry, evicted at bound 0
    expect(map.has(2)).toBe(true); // still pending — never evicted
    expect(map.has(3)).toBe(true);
  });

  it("evicts the oldest-settled terminal entries first once the bound is exceeded", () => {
    let map = MutationState.seed([mutation(1), mutation(2), mutation(3), mutation(4)]);
    // Settle out of mutationId order, with increasing settledAt, to prove
    // eviction follows settledAt (recency), not mutationId or insertion order.
    map = MutationState.acknowledged(map, 3, 30, { maxTerminal: 2 });
    map = MutationState.acknowledged(map, 1, 10, { maxTerminal: 2 });
    map = MutationState.acknowledged(map, 2, 20, { maxTerminal: 2 });
    // Three terminal entries (1, 2, 3) exceed the bound of 2; the
    // oldest-settled (mutationId 1, settledAt 10) is evicted first.
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(true);
    expect(map.has(3)).toBe(true);
    expect(map.has(4)).toBe(true); // still pending
    expect([...map.values()].filter((s) => s.phase !== "pending")).toHaveLength(2);
  });

  it("a mutation storm never exceeds the configured terminal bound", () => {
    let map = MutationState.seed([]);
    const retention = { maxTerminal: 5 };
    for (let id = 1; id <= 500; id++) {
      map = MutationState.journaled(map, {
        mutationId: id,
        mutator: "todo/set",
        args: {},
        journaledAt: id,
      });
      map = MutationState.acknowledged(map, id, id + 1, retention);
    }
    expect(map.size).toBeLessThanOrEqual(5);
    // The most recently settled survive; the oldest 495 were evicted.
    expect(map.has(500)).toBe(true);
    expect(map.has(496)).toBe(true);
    expect(map.has(1)).toBe(false);
  });

  it("a mix of still-pending and settled mutations stays bounded to pending + maxTerminal", () => {
    let map = MutationState.seed([]);
    const retention = { maxTerminal: 3 };
    // 20 pending mutations never settle...
    for (let id = 1; id <= 20; id++) {
      map = MutationState.journaled(map, {
        mutationId: id,
        mutator: "todo/set",
        args: {},
        journaledAt: id,
      });
    }
    // ...while 50 more journal and immediately settle (a storm on top).
    for (let id = 21; id <= 70; id++) {
      map = MutationState.journaled(map, {
        mutationId: id,
        mutator: "todo/set",
        args: {},
        journaledAt: id,
      });
      map = MutationState.acknowledged(map, id, id + 1, retention);
    }
    expect(map.size).toBeLessThanOrEqual(20 + 3);
    for (let id = 1; id <= 20; id++) expect(map.get(id)?.phase).toBe("pending");
  });
});
