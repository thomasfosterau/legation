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
 * **The declarations.** Linkage follows the resources those endpoints are
 * declared with (`src/lib/resources.ts`), so a locally served document
 * carries exactly the relationships the server writes (ADR-0029 §6;
 * `tests/replica-documents.test.ts` checks the bytes).
 */
import type { Effect } from "effect";
import type { Resource } from "@thomasfosterau/effect-jsonapi";
import type { Query } from "@thomasfosterau/legation-effect";
import type { ClientView, Coverage } from "@thomasfosterau/legation-effect/internal";
import { JsonApiFacade } from "@thomasfosterau/legation-jsonapi";
import { api } from "./api.js";
import { resources as declared } from "./resources.js";
import { nodes } from "./domain.js";

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
}

/** The façade over this app's api and declarations. */
export const makeFacade = (source: FacadeSource): JsonApiFacade.FetchHandler =>
  JsonApiFacade.fetchHandler({ nodes, api, resources, ...source });
