/**
 * MutationState (#116): the pure fold — seed from the journal, fold
 * `journaled`/`acknowledged`/`rejected` transitions, and bound terminal
 * retention so a mutation storm cannot grow the map without limit. Backed by
 * `HashMap` (not the native `Map`) so folding one entry stays `O(log N)`
 * regardless of how many mutations are tracked — see `MutationState.ts`'s
 * module doc and `overlay-delta-scaling.test.ts`'s sibling scaling proof.
 */
import { describe, expect, it } from "@effect/vitest";
import { HashMap, Option } from "effect";
import * as MutationState from "../MutationState.js";
import type { Mutation } from "../Protocol.js";

const mutation = (mutationId: number, mutator = "todo/set"): Mutation => ({
  clientId: "c1",
  mutationId,
  mutator,
  args: { id: String(mutationId) },
  createdAt: 1000 + mutationId,
});

const get = (map: MutationState.MutationStateMap, id: number) =>
  Option.getOrUndefined(HashMap.get(map, id));

describe("MutationState (#116)", () => {
  it("seed reflects every pending journal entry as pending", () => {
    const map = MutationState.seed([mutation(1), mutation(2, "todo/remove")]);
    expect(HashMap.size(map)).toBe(2);
    expect(get(map, 1)).toEqual({
      mutationId: 1,
      mutator: "todo/set",
      args: { id: "1" },
      phase: "pending",
      journaledAt: 1001,
    });
    expect(get(map, 2)?.mutator).toBe("todo/remove");
    expect(get(map, 2)?.phase).toBe("pending");
  });

  it("journaled adds a fresh pending entry", () => {
    const map = MutationState.journaled(HashMap.empty(), {
      mutationId: 5,
      mutator: "todo/set",
      args: { id: "5" },
      journaledAt: 42,
    });
    expect(get(map, 5)).toEqual({
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
    expect(get(next, 1)).toEqual({
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
    expect(get(next, 1)?.phase).toBe("rejected");
    expect(get(next, 1)?.reason).toBe("permission revoked");
    expect(get(next, 1)?.settledAt).toBe(2000);
  });

  it("settling an untracked mutationId is a no-op (nothing to fold)", () => {
    const map = MutationState.seed([]);
    expect(MutationState.acknowledged(map, 999, 1)).toBe(map);
    expect(MutationState.rejected(map, 999, "x", 1)).toBe(map);
  });

  it("a settled entry never moves: a later outcome is a no-op (#364)", () => {
    const acknowledged = MutationState.acknowledged(MutationState.seed([mutation(1)]), 1, 2000);
    expect(MutationState.rejected(acknowledged, 1, "late", 3000)).toBe(acknowledged);
    expect(MutationState.dropped(acknowledged, 1, 3000)).toBe(acknowledged);

    const rejected = MutationState.rejected(MutationState.seed([mutation(2)]), 2, "first", 2000);
    expect(MutationState.acknowledged(rejected, 2, 3000)).toBe(rejected);
    expect(MutationState.rejected(rejected, 2, "second", 3000)).toBe(rejected);
    expect(get(rejected, 2)).toMatchObject({ phase: "rejected", reason: "first", settledAt: 2000 });
  });

  it("retains pending entries regardless of the terminal bound", () => {
    let map = MutationState.seed([mutation(1), mutation(2), mutation(3)]);
    // Bound of 0 terminal entries — every pending stays, since eviction only
    // ever touches terminal (acknowledged/rejected) entries.
    map = MutationState.acknowledged(map, 1, 10, { maxTerminal: 0 });
    expect(HashMap.has(map, 1)).toBe(false); // the only terminal entry, evicted at bound 0
    expect(HashMap.has(map, 2)).toBe(true); // still pending — never evicted
    expect(HashMap.has(map, 3)).toBe(true);
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
    expect(HashMap.has(map, 1)).toBe(false);
    expect(HashMap.has(map, 2)).toBe(true);
    expect(HashMap.has(map, 3)).toBe(true);
    expect(HashMap.has(map, 4)).toBe(true); // still pending
    expect([...HashMap.values(map)].filter((s) => s.phase !== "pending")).toHaveLength(2);
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
    expect(HashMap.size(map)).toBeLessThanOrEqual(5);
    // The most recently settled survive; the oldest 495 were evicted.
    expect(HashMap.has(map, 500)).toBe(true);
    expect(HashMap.has(map, 496)).toBe(true);
    expect(HashMap.has(map, 1)).toBe(false);
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
    expect(HashMap.size(map)).toBeLessThanOrEqual(20 + 3);
    for (let id = 1; id <= 20; id++) expect(get(map, id)?.phase).toBe("pending");
  });

  it("acknowledgedMany folds a batch of ids and evicts exactly once, bounded to maxTerminal", () => {
    let map = MutationState.seed([]);
    for (let id = 1; id <= 10; id++) {
      map = MutationState.journaled(map, {
        mutationId: id,
        mutator: "todo/set",
        args: {},
        journaledAt: id,
      });
    }
    // A single ack sweep settles all ten at once (they share one settledAt,
    // as a real push-ack batch does) — the batch exceeds maxTerminal, so
    // eviction must still bring it down to the bound in one pass.
    const next = MutationState.acknowledgedMany(
      map,
      Array.from({ length: 10 }, (_, i) => i + 1),
      100,
      { maxTerminal: 4 }
    );
    expect(HashMap.size(next)).toBe(4);
    for (const state of HashMap.values(next)) expect(state.phase).toBe("acknowledged");

    // A later, distinctly-timestamped settle evicts across the earlier
    // batch's survivors — genuinely oldest-settled, not a same-timestamp tie.
    const fresh = MutationState.journaled(next, {
      mutationId: 11,
      mutator: "todo/set",
      args: {},
      journaledAt: 101,
    });
    const later = MutationState.acknowledged(fresh, 11, 200, { maxTerminal: 4 });
    expect(HashMap.size(later)).toBe(4);
    expect(HashMap.has(later, 11)).toBe(true); // just-settled, newest — never evicted
  });
});
