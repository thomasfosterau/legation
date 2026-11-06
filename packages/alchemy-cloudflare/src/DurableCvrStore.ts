/**
 * DurableCvrStore
 *
 * `Cvr.CvrStore` over a room's Durable Object storage, through Alchemy's
 * Effect-native `DurableObjectStorage` (`state.storage` of
 * `Cloudflare.DurableObjectState`): the CVRs live co-located with the user's
 * room (ADR-0022's reference topology, superseding the shared-KV variant of
 * ADR-0011 for this deployment). DO storage structured-clones `Map`s
 * natively, so the CVR's nested maps round-trip without serialization code.
 *
 * The storage's effects need Alchemy's `RuntimeContext`; {@link make} captures
 * it once. A failed storage call is a defect there (its effects have no error
 * channel); the store turns it into a `StoreError`.
 */

import type { DurableObjectStorage } from "@alchemy.run/cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { StoreError } from "@thomasfosterau/legation";
import type { Cvr } from "@thomasfosterau/legation/internal";

const KEY_PREFIX = "legation:cvr:";

/** The stored form of one CVR: its nested row map. */
type StoredRows = ReadonlyMap<string, ReadonlyMap<string, string | number>>;

/** Build the store over the room's `state.storage`, in the room's runtime context. */
export const make = (
  storage: DurableObjectStorage
): Effect.Effect<Cvr.CvrStore, never, RuntimeContext> =>
  Effect.map(Effect.service(RuntimeContext), (runtime) => {
    /** Run one storage call with the captured context; a failure is a `StoreError`. */
    const execute = <A>(operation: string, call: Effect.Effect<A, never, RuntimeContext>) =>
      call.pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.catchDefect((cause) =>
          Effect.fail(
            new StoreError({ message: `Durable Object storage ${operation} failed`, cause })
          )
        )
      );
    return {
      get: (cookie) =>
        execute("get", storage.get<StoredRows>(`${KEY_PREFIX}${cookie}`)).pipe(
          Effect.map((rows) => (rows === undefined ? undefined : { rows }))
        ),
      set: (cookie, cvr) => execute("put", storage.put(`${KEY_PREFIX}${cookie}`, cvr.rows)),
      remove: (cookie) =>
        execute("delete", storage.delete(`${KEY_PREFIX}${cookie}`)).pipe(Effect.asVoid),
    };
  });
