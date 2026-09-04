/**
 * The JSON:API read proxy — the browser's `GET /jsonapi/...`, forwarded to
 * the sync server's derived handlers (`server/jsonapi.ts`) as the session
 * user.
 *
 * The sync server trusts `x-commerce-user`, so a browser must never reach
 * it directly; this route is the same trust boundary the loads cross
 * (`server/client.ts`): the Kit process resolves the Better Auth session
 * (`hooks.server.ts`) and vouches for it in the header, and whatever the
 * client sent under that name is dropped. Reads only — the writes stay
 * form actions through the typed client (the façade's writes are #169).
 *
 * The URL is forwarded as received: the derived handler parses the same
 * grammar the façade parses, and a locally served document must be the
 * document this route returns for the same URL, byte for byte on content
 * (ADR-0029 §6; `tests/facade-browser.test.ts` checks it in a browser).
 * The universal catalog load (`src/routes/+page.ts`) calls this route
 * in-process on the server and through the service worker in the browser.
 */
import type { RequestHandler } from "./$types";
import { MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi";
import { SYNC_ORIGIN } from "../../../../server/client.js";
import { API_PREFIX } from "../../../lib/reads.js";

export const GET: RequestHandler = async ({ params, url, request, locals }) => {
  const upstream = await fetch(`${SYNC_ORIGIN}${API_PREFIX}/${params.path}${url.search}`, {
    headers: {
      accept: request.headers.get("accept") ?? MEDIA_TYPE,
      ...(locals.user === undefined ? {} : { "x-commerce-user": locals.user.id }),
    },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? MEDIA_TYPE },
  });
};
