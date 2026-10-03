/**
 * DurableCvrStore
 *
 * `Cvr.CvrStore` over a room's Durable Object storage — the CVRs live
 * co-located with the user's room (ADR-0022's reference topology,
 * superseding the shared-KV variant of ADR-0011 for this deployment).
 * DO storage structured-clones `Map`s natively, so the CVR's nested maps
 * round-trip without serialization code.
 */

import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { StoreError } from "@thomasfosterau/legation-effect";
import type { Cvr } from "@thomasfosterau/legation-effect/internal";

const KEY_PREFIX = "legation:cvr:";

const asStoreError = (operation: string) => (cause: unknown) =>
  new StoreError({ message: `Durable Object storage ${operation} failed`, cause });

/** Build the store over the room's `state.storage`. */
export const make = (storage: DurableObjectStorage): Cvr.CvrStore => ({
  get: (cookie) =>
    Effect.tryPromise({
      try: async () => {
        const rows = await storage.get<ReadonlyMap<string, ReadonlyMap<string, string | number>>>(
          `${KEY_PREFIX}${cookie}`
        );
        return rows === undefined ? undefined : { rows };
      },
      catch: asStoreError("get"),
    }),
  set: (cookie, cvr) =>
    Effect.tryPromise({
      try: async () => {
        await storage.put(`${KEY_PREFIX}${cookie}`, cvr.rows);
      },
      catch: asStoreError("put"),
    }),
  remove: (cookie) =>
    Effect.tryPromise({
      try: async () => {
        await storage.delete(`${KEY_PREFIX}${cookie}`);
      },
      catch: asStoreError("delete"),
    }),
});
