/**
 * Mutation
 *
 * Mutation descriptors. A `MutationDescriptor` declares how to perform a
 * write: the effect that pushes it upstream, optimistic cache patches to
 * apply while it is in flight, and the keys/tags to invalidate once it
 * succeeds.
 *
 * Mutations are executed against a `SyncCache` so that optimistic
 * updates, rollback, and invalidation are coordinated with everything
 * else reading that cache.
 */

import { Effect, Option } from "effect";
import type { StoreError } from "./Errors.js";
import type { SyncCache } from "./SyncCache.js";
import * as SyncKey from "./SyncKey.js";
import type { CacheEntry } from "./CacheStore.js";

/**
 * A single optimistic patch to the cache: how to compute the optimistic
 * value for `key` from the current cached value (if any).
 */
export interface OptimisticUpdate {
  readonly key: SyncKey.SyncKey;
  readonly update: (current: Option.Option<unknown>) => unknown;
}

/**
 * Declarative description of a mutation.
 *
 * @typeParam Input - the caller-supplied input to the mutation
 * @typeParam A - the mutation's result
 */
export interface MutationDescriptor<Input, A, E = never, R = never> {
  /** Key identifying this mutation (for tracking and the outbox). */
  readonly key: SyncKey.SyncKey;
  /** Perform the mutation upstream and return its canonical result. */
  readonly execute: (input: Input) => Effect.Effect<A, E, R>;
  /** Optimistic cache patches applied while the mutation is in flight. */
  readonly optimistic?: ((input: Input) => ReadonlyArray<OptimisticUpdate>) | undefined;
  /** Keys invalidated after the mutation succeeds. */
  readonly invalidates?: ReadonlyArray<SyncKey.SyncKey> | undefined;
  /** Tags invalidated after the mutation succeeds. */
  readonly invalidatesTags?: ReadonlyArray<string> | undefined;
  /** Write the mutation result into the cache under these keys. */
  readonly updates?:
    | ((
        input: Input,
        result: A
      ) => ReadonlyArray<{ readonly key: SyncKey.SyncKey; readonly value: unknown }>)
    | undefined;
}

/**
 * Construct a mutation descriptor.
 */
export const make = <Input, A, E = never, R = never>(
  descriptor: MutationDescriptor<Input, A, E, R>
): MutationDescriptor<Input, A, E, R> => descriptor;

interface AppliedPatch {
  readonly key: SyncKey.SyncKey;
  readonly previous: Option.Option<CacheEntry>;
}

/**
 * Execute a mutation against a cache:
 *
 * 1. apply optimistic patches (remembering previous entries)
 * 2. run the mutation
 * 3. on success: write result updates, invalidate keys/tags
 * 4. on failure: roll back the optimistic patches
 */
export const execute = <Input, A, E, R>(
  cache: SyncCache,
  descriptor: MutationDescriptor<Input, A, E, R>,
  input: Input
): Effect.Effect<A, E | StoreError, R> =>
  Effect.gen(function* () {
    // 1. Apply optimistic patches, remembering what was there before.
    const patches = descriptor.optimistic?.(input) ?? [];
    const applied: Array<AppliedPatch> = [];

    for (const patch of patches) {
      const previous = yield* cache.peek(patch.key);
      const currentValue = Option.map(previous, (entry) => entry.value);
      yield* cache.set(patch.key, patch.update(currentValue));
      applied.push({ key: patch.key, previous });
    }

    const rollback: Effect.Effect<void, StoreError> = Effect.forEach(
      applied,
      (patch) =>
        Option.isSome(patch.previous)
          ? Effect.asVoid(
              cache.set(patch.key, patch.previous.value.value, {
                tags: patch.previous.value.tags,
                version: patch.previous.value.version,
              })
            )
          : Effect.asVoid(cache.remove(patch.key)),
      { discard: true }
    );

    // 2. Run the mutation, rolling back optimistic patches on failure.
    const result = yield* descriptor
      .execute(input)
      .pipe(Effect.onError(() => Effect.ignore(rollback)));

    // 3. Write result updates into the cache.
    const updates = descriptor.updates?.(input, result) ?? [];
    yield* Effect.forEach(updates, (update) => cache.set(update.key, update.value), {
      discard: true,
    });

    // 4. Invalidate dependent keys and tags.
    yield* Effect.forEach(
      descriptor.invalidates ?? [],
      (key) => cache.invalidate(SyncKey.prefixFilter(key)),
      { discard: true }
    );
    if (descriptor.invalidatesTags !== undefined && descriptor.invalidatesTags.length > 0) {
      yield* cache.invalidateTags(descriptor.invalidatesTags);
    }

    return result;
  });
