/**
 * Ledger
 *
 * The ledger a `JsonApiBackend` keeps for each client group (#468): the highest
 * acknowledged mutation id per client (`lastMutationIds`) and the permanent
 * rejections it still remembers, each with its reason (#366, #365). A
 * `LedgerStore` is where that state is read from and written to. The default,
 * {@link memory}, keeps nothing, so the backend's own in-memory copy is the
 * ledger and a restart forgets it. {@link keyValue} stores each group's ledger
 * in an Effect `KeyValueStore`, which survives a restart when that store does.
 */

import { Effect, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { BackendError } from "@thomasfosterau/legation-effect";

/** A permanent rejection the ledger remembers: the mutation and the reason it was refused. */
export interface Rejection {
  readonly clientId: string;
  readonly mutationId: number;
  readonly reason: string;
}

/** One client group's ledger, as a store holds it. */
export interface GroupLedger {
  /** Highest acknowledged mutation id per client. */
  readonly lastMutationIds: Readonly<Record<string, number>>;
  /** The rejections still remembered, for replayed copies and pulls. */
  readonly rejections: ReadonlyArray<Rejection>;
}

/** An empty group ledger: nothing acknowledged, nothing remembered. */
export const emptyGroup: GroupLedger = { lastMutationIds: {}, rejections: [] };

/**
 * Where a `JsonApiBackend` reads and writes each client group's ledger (#468).
 * `read` is called once per group when the backend first needs it; `write`
 * replaces the group's stored ledger after each change, and only after the
 * server has applied the writes the change acknowledges.
 */
export interface LedgerStore {
  /** The stored ledger of a client group, or {@link emptyGroup} when it has none. */
  readonly read: (clientGroupId: string) => Effect.Effect<GroupLedger, BackendError>;
  /** Replace a client group's stored ledger with `ledger`. */
  readonly write: (clientGroupId: string, ledger: GroupLedger) => Effect.Effect<void, BackendError>;
}

/**
 * The in-memory ledger store: it persists nothing, so the backend keeps each
 * group's ledger in its own memory for the life of the instance. A restart of
 * the backend forgets every acknowledged id and remembered rejection.
 */
export const memory: LedgerStore = {
  read: () => Effect.succeed(emptyGroup),
  write: () => Effect.void,
};

const RejectionSchema = Schema.Struct({
  clientId: Schema.String,
  mutationId: Schema.Number,
  reason: Schema.String,
});

const GroupLedgerSchema = Schema.Struct({
  lastMutationIds: Schema.Record(Schema.String, Schema.Number),
  rejections: Schema.Array(RejectionSchema),
});

const decodeGroup = Schema.decodeUnknownEffect(GroupLedgerSchema);

/**
 * A ledger store over an Effect `KeyValueStore`: each client group's ledger is
 * one JSON value under `${prefix}${clientGroupId}`. Use a durable key/value
 * store (a file system, SQL or browser storage layer) for it to survive a
 * restart. A stored value that does not decode is a `BackendError`, not an
 * empty ledger, so a corrupt store is never mistaken for a fresh one.
 */
export const keyValue = (
  store: KeyValueStore.KeyValueStore,
  options: { readonly prefix?: string } = {}
): LedgerStore => {
  const keyOf = (clientGroupId: string) =>
    `${options.prefix ?? "legation-jsonapi:ledger:"}${clientGroupId}`;
  return {
    read: (clientGroupId) =>
      store.get(keyOf(clientGroupId)).pipe(
        Effect.mapError((cause) => new BackendError({ message: "Ledger read failed", cause })),
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed(emptyGroup)
            : Effect.try({
                try: () => JSON.parse(raw) as unknown,
                catch: (cause) => new BackendError({ message: "Ledger is not JSON", cause }),
              }).pipe(
                Effect.flatMap((value) =>
                  decodeGroup(value).pipe(
                    Effect.mapError(
                      (cause) => new BackendError({ message: "Ledger does not decode", cause })
                    )
                  )
                )
              )
        )
      ),
    write: (clientGroupId, ledger) =>
      store
        .set(keyOf(clientGroupId), JSON.stringify(ledger))
        .pipe(
          Effect.mapError((cause) => new BackendError({ message: "Ledger write failed", cause }))
        ),
  };
};
