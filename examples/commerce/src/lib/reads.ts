/**
 * A read as a plain `fetch` — the universal loads' read path, and the
 * plain-fetch front of ADR-0029 seen from the page.
 *
 * `readPath` spells a declarative read (`src/lib/domain.ts`) as its
 * canonical JSON:API string under the api's mount (`JsonApiQuery.canonical`,
 * one string per plan, ADR-0029 §2); `readCollection` fetches it with the
 * `fetch` a SvelteKit `load` is handed and decodes the document with the
 * resource's own collection schema. On the server that `fetch` calls the
 * app's read proxy (`src/routes/jsonapi/[...path]/+server.ts`) in-process;
 * in the browser it is the tab's `fetch`, which the service worker's façade
 * intercepts and answers from the replica when the shell's pins cover the
 * URL — the same string the tab subscribes to, so "same URL, same result"
 * holds across SSR, client navigation and the replica. A response that is
 * not a document — the server's 400, the façade's 503 `offline` document —
 * is the page's error, carrying the JSON:API error's title.
 *
 * Nothing here is server-only: no `process.env`, no HTTP client layer, so
 * the module bundles into the client and the worker alike (compare
 * `server/client.ts`, the Kit process's typed client for the writes).
 */
import { error } from "@sveltejs/kit";
import { Schema } from "effect";
import { MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi";
import type { Query } from "@legation/effect";
import { JsonApiQuery } from "@legation/jsonapi";
import { nodes } from "./domain.js";

/** The api's mount path, as the browser sees it. */
export const API_PREFIX = "/jsonapi";

/**
 * The origin-relative JSON:API URL of a read: its canonical string under
 * {@link API_PREFIX}. Throws a `QueryError` for a read the grammar cannot
 * spell — a definition bug in the app's reads, never request state.
 */
export const readPath = (read: Query.Read): string =>
  `${API_PREFIX}${JsonApiQuery.canonical(nodes, read)}`;

/** A JSON:API error document's first error, when the body is one. */
const firstError = (body: unknown): { readonly title?: string; readonly detail?: string } => {
  const errors = (body as { errors?: ReadonlyArray<unknown> } | null)?.errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  return typeof first === "object" && first !== null ? first : {};
};

/**
 * `GET` a read's canonical URL with the given `fetch` and decode the body
 * with the resource's collection document schema (`Product.collection()`)
 * — the shape the pages' `initial` seeds are built from. A non-2xx
 * response is the page's error at that status.
 */
export const readCollection = async <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  fetch: typeof globalThis.fetch,
  document: S,
  read: Query.Read
): Promise<S["Type"]> => {
  const path = readPath(read);
  const response = await fetch(path, { headers: { accept: MEDIA_TYPE } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const { title, detail } = firstError(body);
    error(response.status, detail ?? title ?? `${path}: ${response.status}`);
  }
  return Schema.decodeUnknownSync(document)(body);
};
