/**
 * Versioned values and conflict resolution
 *
 * A `Versioned<A>` pairs a value with the version the writer observed and
 * the time it was written. Versions are how the engine detects conflicting
 * writes; `ConflictStrategy` describes how a conflict should be resolved.
 */

import { Effect } from "effect";
import { ConflictError } from "./Errors.js";
import type { SyncKey } from "./SyncKey.js";

/**
 * A resource version. Number versions are compared numerically; string
 * versions are opaque (only equality is meaningful).
 */
export type Version = string | number;

/**
 * A value paired with its version and write timestamp.
 */
export interface Versioned<A> {
  readonly value: A;
  readonly version: Version;
  readonly updatedAt: number;
}

/**
 * Construct a versioned value.
 */
export const make = <A>(value: A, version: Version, updatedAt: number): Versioned<A> => ({
  value,
  version,
  updatedAt,
});

/**
 * How to resolve a conflict between a local and a remote version of the
 * same resource:
 *
 * - `preferLocal`: the local value wins
 * - `preferRemote`: the remote value wins
 * - `lastWriteWins`: the value with the newest `updatedAt` wins
 * - `fail`: fail with `ConflictError`
 * - a merge function producing the resolved value
 */
export type ConflictStrategy<A> =
  | "preferLocal"
  | "preferRemote"
  | "lastWriteWins"
  | "fail"
  | ((local: Versioned<A>, remote: Versioned<A>) => Versioned<A>);

/**
 * Resolve a conflict between a local and remote versioned value according
 * to a strategy.
 */
export const resolve = <A>(options: {
  readonly key: SyncKey;
  readonly local: Versioned<A>;
  readonly remote: Versioned<A>;
  readonly strategy: ConflictStrategy<A>;
}): Effect.Effect<Versioned<A>, ConflictError> => {
  const { key, local, remote, strategy } = options;
  if (typeof strategy === "function") {
    return Effect.sync(() => strategy(local, remote));
  }
  switch (strategy) {
    case "preferLocal":
      return Effect.succeed(local);
    case "preferRemote":
      return Effect.succeed(remote);
    case "lastWriteWins":
      return Effect.succeed(remote.updatedAt >= local.updatedAt ? remote : local);
    case "fail":
      return Effect.fail(
        new ConflictError({
          key,
          message: "Conflicting versions",
          localVersion: local.version,
          remoteVersion: remote.version,
        })
      );
  }
};

/**
 * Returns `true` when two versions are known to conflict, i.e. they are
 * different versions of the same resource.
 */
export const isConflict = (local: Version | undefined, remote: Version | undefined): boolean =>
  local !== undefined && remote !== undefined && local !== remote;
