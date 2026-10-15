/**
 * A ledger store that fails on demand, for the ledger-store failure tests (#468).
 */
import { Effect, Ref } from "effect";
import { BackendError } from "@thomasfosterau/legation-effect";
import type * as Ledger from "../Ledger.js";

/** Fail with a `BackendError` while `faults` has a fault left, counting one down. */
const fault = (faults: Ref.Ref<number>, message: string) =>
  Ref.getAndUpdate(faults, (n) => Math.max(0, n - 1)).pipe(
    Effect.flatMap((before) =>
      before > 0 ? Effect.fail(new BackendError({ message })) : Effect.void
    )
  );

/**
 * A ledger store over `inner` that fails the next `failWrites` writes and the
 * next `failReads` reads with a `BackendError`, as a store that cannot be
 * reached would. Each counter counts down by one per call.
 */
export const flakyLedger = (
  inner: Ledger.LedgerStore,
  faults: { readonly failWrites: Ref.Ref<number>; readonly failReads: Ref.Ref<number> }
): Ledger.LedgerStore => ({
  read: (clientGroupId) =>
    fault(faults.failReads, "Ledger read failed").pipe(Effect.andThen(inner.read(clientGroupId))),
  write: (clientGroupId, ledger) =>
    fault(faults.failWrites, "Ledger write failed").pipe(
      Effect.andThen(inner.write(clientGroupId, ledger))
    ),
});
