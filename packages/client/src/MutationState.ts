/**
 * MutationState
 *
 * Observable mutation state, the write-side counterpart to
 * `Query.QueryState`. A mutation moves through `idle` → `pending` →
 * `success`/`failure`, and `observeMutation` exposes that progression as a
 * `Stream` so UIs can render pending spinners and error banners.
 */

import { Effect, Option, Stream } from "effect";
import { type Mutation, type StoreError } from "@thomasfosterau/effect-sync-core";
import type { QueryClient } from "./QueryClient.js";

/**
 * Lifecycle status of a mutation.
 */
export type MutationStatus = "idle" | "pending" | "success" | "failure";

/**
 * The state of an observed mutation.
 */
export interface MutationState<A, E = unknown> {
  readonly status: MutationStatus;
  /** The mutation result, once it has succeeded. */
  readonly data: Option.Option<A>;
  /** The mutation error, once it has failed. */
  readonly error: Option.Option<E | StoreError>;
}

/**
 * The initial (idle) mutation state.
 */
export const idleState = <A, E = unknown>(): MutationState<A, E> => ({
  status: "idle",
  data: Option.none(),
  error: Option.none(),
});

/**
 * State transition: the mutation started.
 */
export const toPending = <A, E>(state: MutationState<A, E>): MutationState<A, E> => ({
  ...state,
  status: "pending",
});

/**
 * State transition: the mutation succeeded.
 */
export const toSuccess = <A, E>(value: A): MutationState<A, E> => ({
  status: "success",
  data: Option.some(value),
  error: Option.none(),
});

/**
 * State transition: the mutation failed.
 */
export const toFailure = <A, E>(error: E | StoreError): MutationState<A, E> => ({
  status: "failure",
  data: Option.none(),
  error: Option.some(error),
});

/**
 * Observe a mutation as a stream of {@link MutationState}.
 *
 * Emits `pending` immediately, then either `success` (with the result) or
 * `failure` (with the error). The mutation runs against the cache via the
 * supplied {@link QueryClient}, so optimistic patches and invalidation
 * still happen; failures are surfaced as state, not as a stream failure.
 */
export const observeMutation = <Input, A, E, R>(
  client: QueryClient,
  descriptor: Mutation.MutationDescriptor<Input, A, E, R>,
  input: Input
): Stream.Stream<MutationState<A, E>, never, R> =>
  Stream.concat(
    Stream.succeed(toPending(idleState<A, E>())),
    Stream.fromEffect(
      Effect.map(Effect.result(client.mutate(descriptor, input)), (result) =>
        result._tag === "Success"
          ? toSuccess<A, E>(result.success)
          : toFailure<A, E>(result.failure as E | StoreError)
      )
    )
  );
