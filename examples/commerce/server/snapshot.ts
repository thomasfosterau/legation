/**
 * The page's SSR snapshot (ADR-0020, #146): the root layout's `load` renders
 * the app shell's working set (`shellReads`) over a request-scoped engine
 * under the browser's client group, and ships the dehydrated rows and CVR
 * cookie in the page data. The tab hands it to the service worker's engine
 * (`createClient`'s `snapshot`), which hydrates its IndexedDB replica only
 * when that replica is empty and has not pulled — so a first visit's worker
 * starts with the rows the page rendered and its first pull continues from
 * this cookie, while a returning visitor's replica is never touched.
 *
 * The Kit process does not hold the backend: the sync server is its own
 * process. So the render pulls over a carrier to it — the sync RPCs over
 * plain HTTP POST (`/sync`), one round trip, no WebSocket for a single pull.
 * The group id travels on the pull and the server's fresh cookie comes back,
 * so the cookie belongs to the browser's own CVR conversation. The identity
 * is the server's to resolve from that group's binding (`hooks.server.ts`
 * aligns it before any `load` runs), never asserted here.
 */
import type { Cookies } from "@sveltejs/kit";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { Hydration } from "@thomasfosterau/legation";
import { RpcTransport } from "@thomasfosterau/legation/internal";
import { clientGroupId, loadSnapshot } from "@thomasfosterau/legation-svelte/kit";
import { nodes, shellReads } from "../src/lib/domain.js";
import { SYNC_ORIGIN } from "./client.js";

/**
 * The shell's snapshot for this request, or `undefined` when the sync server
 * cannot render it: the page then falls back to its JSON:API seeds, and the
 * worker's engine syncs from scratch, which is slower but never wrong.
 */
export const shellSnapshot = (
  cookies: Cookies,
  userId: string | undefined
): Promise<Hydration.Snapshot | undefined> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const group = clientGroupId(cookies);
        const http = yield* Layer.build(
          RpcClient.layerProtocolHttp({ url: `${SYNC_ORIGIN}/sync` }).pipe(
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(FetchHttpClient.layer)
          )
        );
        const transport = yield* RpcTransport.make({ clientGroupId: group }).pipe(
          Effect.provide(http)
        );
        const { snapshot } = yield* loadSnapshot(cookies, {
          nodes,
          reads: shellReads(userId),
          transport,
        });
        return snapshot;
      })
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("commerce: the shell snapshot could not be rendered", error).pipe(
          Effect.as(undefined)
        )
      )
    )
  );
