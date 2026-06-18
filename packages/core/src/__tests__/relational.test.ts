/**
 * Relational `Exists` predicate: a backend resolves a correlated join to an
 * allow-set. Here MemoryBackend evaluates "issues visible to a user" as
 * `exists(memberships where userId = … and memberships.projectId =
 * issue.projectId)` — relationship-scoped visibility with no denormalization of
 * membership onto the issue row.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import type { Mutation } from "../Protocol.js";

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "issue/set": (args, writer) =>
    Effect.asVoid(writer.put("issues", (args as { id: string }).id, args)),
  "membership/set": (args, writer) =>
    Effect.asVoid(writer.put("memberships", (args as { id: string }).id, args)),
};

const mutation = (mutationId: number, mutator: string, args: unknown): Mutation => ({
  clientId: "seed",
  mutationId,
  mutator,
  args,
  createdAt: 0,
});

const seed = [
  mutation(1, "issue/set", { id: "i1", projectId: "p1" }),
  mutation(2, "issue/set", { id: "i2", projectId: "p2" }),
  mutation(3, "issue/set", { id: "i3", projectId: "p1" }),
  mutation(4, "membership/set", { id: "m1", userId: "alice", projectId: "p1" }),
  mutation(5, "membership/set", { id: "m2", userId: "bob", projectId: "p2" }),
];

const visibleToUser = (userId: string) =>
  Subset.make({
    collection: "issues",
    where: Predicate.exists({
      collection: "memberships",
      localField: "projectId",
      foreignField: "projectId",
      where: Predicate.eq("userId", userId),
    }),
  });

const ids = (entries: ReadonlyArray<{ readonly id: string }>) =>
  entries.map((e) => e.id).toSorted();

describe("Exists predicate (MemoryBackend)", () => {
  it.effect("resolves a correlated join to relationship-scoped visibility", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      yield* backend.applyMutations({ clientGroupId: "g" }, seed);

      // Each user sees only issues in a project they're a member of — without
      // any membership key denormalized onto the issue row.
      expect(ids(yield* backend.evaluate({ clientGroupId: "g" }, visibleToUser("alice")))).toEqual([
        "i1",
        "i3",
      ]);
      expect(ids(yield* backend.evaluate({ clientGroupId: "g" }, visibleToUser("bob")))).toEqual([
        "i2",
      ]);
    })
  );
});
