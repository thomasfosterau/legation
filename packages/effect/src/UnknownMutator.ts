/**
 * UnknownMutator
 *
 * The typed failure a Backend raises when a pushed mutation names a mutator
 * with no registered handler. Backends build it with `make`, and the backend
 * contract recognises it with `isError`, so the check does not depend on the
 * wording of the message. The contract falls back to the message text for a
 * backend that does not use `make` yet.
 */

import { BackendError } from "./Errors.js";

/** The `cause` of a {@link BackendError} raised for a mutator with no registered handler. */
export interface Cause {
  readonly _tag: "UnknownMutator";
  readonly mutator: string;
}

/** Build the transient `BackendError` for a mutator with no registered handler. */
export const make = (mutator: string): BackendError =>
  new BackendError({
    message: `Unknown mutator: ${mutator}`,
    cause: { _tag: "UnknownMutator", mutator } satisfies Cause,
  });

/**
 * True when `error` is a `BackendError` built by {@link make}, so its `cause` is
 * the typed unknown-mutator cause, whatever its message says.
 */
export const isError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if (!("_tag" in error) || error._tag !== "BackendError") return false;
  if (!("cause" in error)) return false;
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "UnknownMutator"
  );
};
