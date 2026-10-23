/**
 * The JSON:API façade (ADR-0029, #166) as this app builds it: a plain
 * `fetch()` of a catalog or account URL, answered from the worker's replica
 * when the shell's pins cover it. The worker composes it first in its
 * `fetch` listener (src/service-worker.ts); this module only says what the
 * façade is built from.
 *
 * **The routes** are the api's own (`src/lib/api.ts`, the shape both the
 * server and this worker load): its `list` / `get` endpoints, declared with
 * the node graph's codec and served by the derived handlers, so the URLs
 * the façade answers are the URLs the server serves, under one grammar —
 * the parity the façade presumes.
 *
 * **The writes** (ADR-0030, #510): with the engine's `mutateWithAck`, a
 * `POST /jsonapi/reviews` carrying a client id is journaled as the
 * graph-derived `reviews/create` while offline (or on
 * `Prefer: respond-async`) and answered with a `202` write receipt; online
 * it is forwarded and the façade pulls after the server's `2xx`. The
 * receipt's `Location`, `/jsonapi/_legation/mutations/{id}`, is answered
 * from the engine's mutation-state map: `pending`, then `acknowledged` or
 * `rejected` with the server's reason (`Prefer: wait=N` holds for it). Only the
 * types and operations in `facadeWrites` are intercepted, because only those
 * have a server handler under the derived name.
 *
 * **The declarations.** Linkage follows the resources those endpoints are
 * declared with (`src/lib/resources.ts`), so a locally served document
 * carries exactly the relationships the server writes (ADR-0029 §6;
 * `tests/replica-documents.test.ts` checks the bytes).
 */
import type { Effect, Stream } from "effect";
import type { MutatorError, StoreError } from "@thomasfosterau/legation-effect";
import type { Resource } from "@thomasfosterau/effect-jsonapi";
import type { Query } from "@thomasfosterau/legation-effect";
import type {
  ClientEngine,
  ClientView,
  Coverage,
  MutationState,
} from "@thomasfosterau/legation-effect/internal";
import { JsonApiFacade } from "@thomasfosterau/legation-jsonapi";
import { api } from "./api.js";
import { resources as declared } from "./resources.js";
import { facadeWrites, nodes } from "./domain.js";

/** The resource declarations the api's endpoints carry, by type. */
export const resources: ReadonlyMap<string, Resource.Any> = new Map(
  declared.map((resource) => [resource.type, resource])
);

/** What the façade reads: the replica, its ledger's verdict, and its cookie. */
export interface FacadeSource {
  /** The replica: `ClientView.fromEngine(engine)` in the worker, `client.view` in a test. */
  readonly view: ClientView.Reader;
  /** The ledger: the host's registrations in the worker, `client.coverageOf` in a test. */
  readonly coverageOf: (read: Query.Read) => Effect.Effect<Coverage.Verdict>;
  /** The replica's CVR cookie (`store.getCookie`), for `x-legation-served-at`. */
  readonly cookie: Effect.Effect<string | undefined, unknown>;
  /** Connectivity; defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
  /** The journal seam: the worker engine's `mutateWithAck`. Absent, writes are never intercepted. */
  readonly mutate?: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<ClientEngine.MutationHandle, MutatorError | StoreError>;
  /** The pull to signal after a forwarded write succeeds: the worker engine's `pull`. */
  readonly pull?: Effect.Effect<unknown, unknown>;
  /** The engine's mutation-state map, which the mutation status URL is answered from. */
  readonly mutationStates?: Stream.Stream<MutationState.MutationStateMap>;
}

/** The façade over this app's api and declarations. */
export const makeFacade = (source: FacadeSource): JsonApiFacade.FetchHandler =>
  JsonApiFacade.fetchHandler({ nodes, api, resources, writes: facadeWrites, ...source });
