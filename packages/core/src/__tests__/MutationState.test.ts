import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import { CacheStore } from "../CacheStore.js";
import * as MutationState from "../MutationState.js";
import * as QueryClient from "../QueryClient.js";

const testLayer = QueryClient.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const withClient = <A, E>(
  program: (
    client: QueryClient.QueryClient
  ) => Effect.Effect<A, E, QueryClient.QueryClient | CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(QueryClient.QueryClient), program).pipe(
      Effect.provide(testLayer)
    ) as Effect.Effect<A, E>
  );

describe("MutationState.observeMutation", () => {
  it("emits pending then success", async () => {
    const states = await withClient((client) =>
      Stream.runCollect(
        MutationState.observeMutation(
          client,
          { key: ["m"], execute: () => Effect.succeed(42) },
          undefined
        )
      )
    );
    expect(states).toHaveLength(2);
    expect(states[0]?.status).toBe("pending");
    expect(states[1]?.status).toBe("success");
    expect(Option.getOrUndefined(states[1]?.data ?? Option.none())).toBe(42);
  });

  it("emits pending then failure", async () => {
    const states = await withClient((client) =>
      Stream.runCollect(
        MutationState.observeMutation(
          client,
          { key: ["m"], execute: () => Effect.fail("boom" as const) },
          undefined
        )
      )
    );
    expect(states[0]?.status).toBe("pending");
    expect(states[1]?.status).toBe("failure");
    expect(Option.getOrUndefined(states[1]?.error ?? Option.none())).toBe("boom");
  });
});
