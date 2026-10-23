/**
 * MutationStatus
 *
 * The **mutation status URL** of a façade write (ADR-0030 §2):
 * `{prefix}/_legation/mutations/{mutationId}`, a `GET` the façade answers
 * from the engine's mutation-state map (`ClientEngine.mutationStates`,
 * #116) and never forwards — the server has no such resource. Where a
 * plain-fetch caller learns whether the intent its `202` receipt named was
 * applied, or permanently rejected and why.
 *
 * - `200 OK`: one `legation-mutations` resource whose attributes are the
 *   mutation's `phase` (`MutationState.MutationPhase` verbatim: `pending`,
 *   `acknowledged`, `rejected`, `dropped`), `mutator`, `journaledAt`,
 *   `settledAt` once settled and `reason` only when rejected; `links.self`
 *   and, for a graph-derived CRUD mutation, `links.resource`. The args are
 *   never exposed: the status is about the intent's fate, not its content.
 * - `404 Not Found`, `code: "unknown_mutation"`, for an id the map does not
 *   hold: never journaled by this engine, settled and evicted beyond the
 *   retention window, or settled before this worker started — the three are
 *   indistinguishable (ADR-0030 open point 1). A pending mutation survives a
 *   worker restart, because the journal seeds the map.
 * - `Prefer: wait=N` (RFC 7240 §4.3) holds a `pending` answer until the
 *   mutation leaves `pending` or `N` seconds pass, capped by the façade
 *   (default 30 s), answering the current phase either way, with
 *   `Preference-Applied: wait=N` (the wait applied, after the cap).
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Stream from "effect/Stream";
import type { Node } from "@thomasfosterau/legation-effect";
import type { MutationState } from "@thomasfosterau/legation-effect/internal";
import type * as RestHandlers from "./RestHandlers.js";

/** The JSON:API type of a status resource; `_legation` and this type are never an app's. */
export const resourceType = "legation-mutations";

/** The path segments of the status route after the api prefix: `/_legation/mutations/{id}`. */
export const segment = "_legation";

/** The default cap on `Prefer: wait`: a `respondWith` promise must not outlive the worker's patience. */
export const defaultMaxWait: Duration.Input = "30 seconds";

/** The status resource of one tracked mutation. */
export interface StatusResource {
  readonly type: typeof resourceType;
  readonly id: string;
  readonly attributes: {
    readonly phase: MutationState.MutationPhase;
    readonly mutator: string;
    readonly journaledAt: number;
    readonly settledAt?: number;
    readonly reason?: string;
  };
  readonly links: { readonly self: string; readonly resource?: string };
}

/**
 * The link to the resource a graph-derived CRUD mutation (`{type}/create|update|delete`,
 * args `{ type, id, … }`) addresses: `{prefix}/{type}/{id}`. `undefined` for any other mutation.
 */
const resourceLink = (
  nodes: Node.NodeRegistry,
  prefix: string,
  state: MutationState.MutationState
): string | undefined => {
  const parts = state.mutator.split("/");
  const [type = "", operation = ""] = parts;
  if (parts.length !== 2 || !nodes.nodes.has(type)) return undefined;
  if (operation !== "create" && operation !== "update" && operation !== "delete") return undefined;
  const args = state.args;
  if (!P.isObject(args) || !("id" in args) || !P.isString(args.id)) return undefined;
  return `${prefix}/${type}/${encodeURIComponent(args.id)}`;
};

/** The `200` document of the status URL: one status resource. */
export interface StatusDocument {
  readonly data: StatusResource;
}

/** The status document of a tracked mutation; `prefix` is where the api is mounted, as links see it. */
export const document = (
  nodes: Node.NodeRegistry,
  prefix: string,
  state: MutationState.MutationState
): StatusDocument => {
  const self = `${prefix}/${segment}/mutations/${state.mutationId}`;
  const resource = resourceLink(nodes, prefix, state);
  const base = { phase: state.phase, mutator: state.mutator, journaledAt: state.journaledAt };
  const settledAt = state.settledAt;
  const timed = settledAt === undefined ? base : { ...base, settledAt };
  const reason = state.phase === "rejected" ? state.reason : undefined;
  return {
    data: {
      type: resourceType,
      id: String(state.mutationId),
      attributes: reason === undefined ? timed : { ...timed, reason },
      links: resource === undefined ? { self } : { self, resource },
    },
  };
};

/** The `404 unknown_mutation` error document. */
export const unknownDocument = (id: string): RestHandlers.ErrorDocument => ({
  errors: [
    {
      status: "404",
      code: "unknown_mutation",
      title: "Unknown mutation",
      detail:
        `No mutation ${id} is tracked here. It was never journaled by this worker, or it ` +
        "settled and was evicted beyond the retention window, or it settled before this worker " +
        "started; the three cannot be told apart.",
    },
  ],
});

/** A mutation id as the route carries it: a positive integer, or none. */
export const parseId = (raw: string): Option.Option<number> =>
  /^[1-9]\d*$/.test(raw) ? Option.some(Number(raw)) : Option.none();

/** One mutation's state now, from the engine's map stream (it emits the current map first). */
export const current = (
  states: Stream.Stream<MutationState.MutationStateMap>,
  mutationId: number
): Effect.Effect<Option.Option<MutationState.MutationState>> =>
  Stream.runHead(states).pipe(Effect.map(Option.flatMap((map) => HashMap.get(map, mutationId))));

/**
 * The mutation's state once it leaves `pending` (or is no longer tracked),
 * or as it is when `wait` elapses first.
 */
export const settled = (
  states: Stream.Stream<MutationState.MutationStateMap>,
  mutationId: number,
  wait: Duration.Duration
): Effect.Effect<Option.Option<MutationState.MutationState>> =>
  states.pipe(
    Stream.map((map) => HashMap.get(map, mutationId)),
    Stream.filter((state) => Option.isNone(state) || state.value.phase !== "pending"),
    Stream.runHead,
    Effect.map(Option.flatten),
    Effect.timeoutOption(wait),
    Effect.flatMap(
      Option.match({
        onNone: () => current(states, mutationId),
        onSome: Effect.succeed,
      })
    )
  );
