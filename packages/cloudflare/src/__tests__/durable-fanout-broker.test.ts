/**
 * DurableFanoutBroker's shard calls (publishes and lease registrations) are
 * bounded (#356 follow-up). A publish runs inside the sync server's
 * uninterruptible region, so a shard that never answers must
 * be aborted at the timeout rather than hold the region open. The fake shard settles
 * only when its request is aborted, and TestClock moves the bound, not wall time.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { FanoutTopics } from "@thomasfosterau/legation-effect/internal";
import * as DurableFanoutBroker from "../DurableFanoutBroker.js";

describe("DurableFanoutBroker shard calls (#356)", () => {
  it.effect("a hung shard call is aborted at its timeout, so the publish returns", () =>
    Effect.gen(function* () {
      const aborted: Array<string> = [];
      const shards = {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: (_url: string, init: { readonly signal: AbortSignal }) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                aborted.push(id);
                reject(new Error("aborted"));
              });
            }),
        }),
      } as unknown as DurableObjectNamespace;
      const { broker } = yield* DurableFanoutBroker.make({ shards, timeout: "3 seconds" });
      const publishing = yield* Effect.forkScoped(
        broker.publish([FanoutTopics.coarse("products")]),
        { startImmediately: true }
      );
      yield* TestClock.adjust("3 seconds");
      expect(Exit.isSuccess(yield* Fiber.await(publishing))).toBe(true);
      // The request was aborted, not merely abandoned.
      expect(aborted).toEqual(["products"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "a hung lease registration is aborted at its timeout, so the registration returns",
    () =>
      Effect.gen(function* () {
        const aborted: Array<string> = [];
        const shards = {
          idFromName: (name: string) => name,
          get: (id: string) => ({
            fetch: (_url: string, init: { readonly signal: AbortSignal }) =>
              new Promise<Response>((_resolve, reject) => {
                init.signal.addEventListener("abort", () => {
                  aborted.push(id);
                  reject(new Error("aborted"));
                });
              }),
          }),
        } as unknown as DurableObjectNamespace;
        const { broker } = yield* DurableFanoutBroker.make({ shards, timeout: "3 seconds" });
        const registering = yield* Effect.forkScoped(
          broker.register("room-a", new Set([FanoutTopics.coarse("products")]), "30 seconds"),
          { startImmediately: true }
        );
        yield* TestClock.adjust("3 seconds");
        expect(Exit.isSuccess(yield* Fiber.await(registering))).toBe(true);
        expect(aborted).toEqual(["products"]);
      }).pipe(Effect.scoped)
  );
});
