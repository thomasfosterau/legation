import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as MutationState from "../MutationState.js";
import * as QueryClient from "../QueryClient.js";

const testLayer = () => QueryClient.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("MutationState.observeMutation", () => {
  it.effect("emits pending then success", () =>
    Effect.gen(function* () {
      const client = yield* QueryClient.QueryClient;
      const states = yield* Stream.runCollect(
        MutationState.observeMutation(
          client,
          { key: ["m"], execute: () => Effect.succeed(42) },
          undefined
        )
      );
      expect(states).toHaveLength(2);
      expect(states[0]?.status).toBe("pending");
      expect(states[1]?.status).toBe("success");
      expect(Option.getOrUndefined(states[1]?.data ?? Option.none())).toBe(42);
    }).pipe(Effect.provide(testLayer())));

  it.effect("emits pending then failure", () =>
    Effect.gen(function* () {
      const client = yield* QueryClient.QueryClient;
      const states = yield* Stream.runCollect(
        MutationState.observeMutation(
          client,
          { key: ["m"], execute: () => Effect.fail("boom" as const) },
          undefined
        )
      );
      expect(states[0]?.status).toBe("pending");
      expect(states[1]?.status).toBe("failure");
      expect(Option.getOrUndefined(states[1]?.error ?? Option.none())).toBe("boom");
    }).pipe(Effect.provide(testLayer())));
});
