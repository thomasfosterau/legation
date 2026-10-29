/**
 * `Backend.transaction` (#177): the combinator owns the ledger rules, whatever
 * the store's steps do. A scripted store records every step it is asked to
 * take, so each test checks what the combinator commits, releases and reports.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { transaction, type Commit, type Outcome, type TransactionSteps } from "../Backend.js";
import { BackendError, MutationRejected } from "../Errors.js";
import type { Mutation } from "../Protocol.js";
import * as UnknownMutator from "../UnknownMutator.js";

type Handler = (mutation: Mutation) => Effect.Effect<string, BackendError | MutationRejected>;

/** A store over a watermark per client, recording the steps the combinator takes. */
const scriptedStore = (options: {
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly rejections?: ReadonlyMap<string, string> | undefined;
  readonly commitResults?: Array<Commit> | undefined;
  readonly refuseNext?: boolean | undefined;
}) => {
  const watermarks = new Map<string, number>();
  const steps: Array<string> = [];
  const commits: Array<Outcome<string>> = [];
  const config: TransactionSteps<Handler, null, Mutation, string> = {
    handlers: options.handlers,
    begin: (_context, floors) =>
      Effect.sync(() => {
        steps.push(`begin ${[...floors].map(([client, floor]) => `${client}:${floor}`).join(",")}`);
        return null;
      }),
    open: (_batch, mutation) =>
      Effect.sync(() => {
        steps.push(`open ${mutation.mutationId}`);
        const last = watermarks.get(mutation.clientId) ?? 0;
        return mutation.mutationId === last + 1 && options.refuseNext !== true
          ? ({ _tag: "Opened", unit: mutation } as const)
          : ({
              _tag: "Watermark",
              lastMutationId: last,
              rejection: options.rejections?.get(`${mutation.clientId}:${mutation.mutationId}`),
            } as const);
      }),
    run: (mutation, handler) => handler(mutation),
    commit: (mutation, outcome) =>
      Effect.sync((): Commit => {
        steps.push(`commit ${mutation.mutationId} ${outcome._tag}`);
        commits.push(outcome);
        const scripted = options.commitResults?.shift() ?? { _tag: "Committed" };
        if (scripted._tag === "Committed") watermarks.set(mutation.clientId, mutation.mutationId);
        return scripted;
      }),
    release: (mutation) => Effect.sync(() => void steps.push(`release ${mutation.mutationId}`)),
    finish: (_batch, applied) =>
      Effect.sync(() => ({
        lastMutationIds: Object.fromEntries(watermarks),
        hints: applied.map((value) => ({ collection: value, ids: [] })),
      })),
  };
  return { applyMutations: transaction(config), steps, commits, watermarks };
};

const mutation = (mutationId: number, mutator = "ok"): Mutation => ({
  clientId: "c",
  mutationId,
  mutator,
  args: {},
  createdAt: 0,
});

const context = { clientGroupId: "g" };
const ok: Handler = () => Effect.succeed("staged");
const reject: Handler = () => Effect.fail(new MutationRejected({ reason: "no" }));
const fail: Handler = () => Effect.fail(new BackendError({ message: "down" }));

describe("Backend.transaction", () => {
  it.effect("applies in order and reports each applied mutation's staged result", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { ok } });
      const result = yield* store.applyMutations(context, [mutation(1), mutation(2)]);
      expect(result.lastMutationIds).toEqual({ c: 2 });
      expect(result.hints).toEqual([
        { collection: "staged", ids: [] },
        { collection: "staged", ids: [] },
      ]);
      expect(result.rejected).toBeUndefined();
      expect(store.steps).toEqual([
        "begin c:1",
        "open 1",
        "commit 1 Applied",
        "open 2",
        "commit 2 Applied",
      ]);
    })
  );

  it.effect("commits a rejection with its reason and none of its staged result", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { ok, reject } });
      const result = yield* store.applyMutations(context, [mutation(1, "reject"), mutation(2)]);
      expect(store.commits[0]).toEqual({ _tag: "Rejected", reason: "no" });
      expect(result.rejected).toEqual([{ clientId: "c", mutationId: 1, reason: "no" }]);
      expect(result.hints).toHaveLength(1);
      expect(result.lastMutationIds).toEqual({ c: 2 });
    })
  );

  it.effect("skips a replay, reporting its committed rejection, without opening a unit", () =>
    Effect.gen(function* () {
      const store = scriptedStore({
        handlers: { ok },
        rejections: new Map([["c:1", "earlier"]]),
      });
      store.watermarks.set("c", 1);
      const result = yield* store.applyMutations(context, [mutation(1), mutation(2)]);
      expect(result.rejected).toEqual([{ clientId: "c", mutationId: 1, reason: "earlier" }]);
      expect(store.steps).not.toContain("commit 1 Applied");
      expect(result.lastMutationIds).toEqual({ c: 2 });
    })
  );

  it.effect("refuses a gap with a BackendError and commits nothing", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { ok } });
      const exit = yield* Effect.exit(store.applyMutations(context, [mutation(2)]));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Mutation id gap for client c: got 2, expected 1");
      expect(store.commits).toEqual([]);
    })
  );

  it.effect("opens nothing for a non-positive id", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { ok } });
      yield* store.applyMutations(context, [mutation(0), mutation(-1)]);
      expect(store.steps.filter((step) => step.startsWith("open"))).toEqual([]);
    })
  );

  it.effect("releases the unit and commits nothing on a transient failure", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { fail } });
      const exit = yield* Effect.exit(store.applyMutations(context, [mutation(1, "fail")]));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(store.steps).toEqual(["begin c:1", "open 1", "release 1"]);
    })
  );

  it.effect("releases the unit and fails with UnknownMutator for a mutator without a handler", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { ok } });
      const error = yield* Effect.flip(store.applyMutations(context, [mutation(1, "missing")]));
      expect(UnknownMutator.isError(error)).toBe(true);
      expect(store.steps).toEqual(["begin c:1", "open 1", "release 1"]);
    })
  );

  it.effect("reports a concurrent copy's committed rejection when the commit replays", () =>
    Effect.gen(function* () {
      const store = scriptedStore({
        handlers: { ok },
        commitResults: [{ _tag: "Replayed", rejection: "raced" }],
      });
      const result = yield* store.applyMutations(context, [mutation(1)]);
      expect(result.rejected).toEqual([{ clientId: "c", mutationId: 1, reason: "raced" }]);
      expect(result.hints).toEqual([]);
    })
  );

  it.effect("reopens and reruns a conflicted commit, then fails transiently past the cap", () =>
    Effect.gen(function* () {
      const store = scriptedStore({
        handlers: { ok },
        commitResults: Array.from({ length: 16 }, (): Commit => ({ _tag: "Conflicted" })),
      });
      const error = yield* Effect.flip(store.applyMutations(context, [mutation(1)]));
      expect(error.message).toContain("serialization conflict");
      expect(store.steps.filter((step) => step === "open 1")).toHaveLength(16);
      expect(store.watermarks.get("c")).toBeUndefined();
    })
  );

  it.effect("fails when the store will not open the client's next mutation", () =>
    Effect.gen(function* () {
      const store = scriptedStore({ handlers: { ok }, refuseNext: true });
      const error = yield* Effect.flip(store.applyMutations(context, [mutation(1)]));
      expect(error.message).toContain("did not open mutation 1");
    })
  );
});
