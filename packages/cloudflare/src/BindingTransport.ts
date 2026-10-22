/**
 * BindingTransport
 *
 * A `ClientTransport` that reaches the sync server over a Cloudflare
 * **service binding** (`env.API.fetch`) rather than over the public network.
 *
 * This is the carrier for the ordinary two-Worker shape: a SvelteKit Worker
 * owns the domain and every HTML/SSR request, and the API Worker holding the
 * database is *binding-only* — `workersDev: false`, no custom domain — so the
 * front door stays the single enforcement point for security headers and
 * cache/auth ordering. `RoomTransport` covers the browser (public HTTP plus a
 * poke socket); nothing covered `env.API.fetch(...)`, which is what an SSR
 * render has to use.
 *
 * Two things have to survive the hop, and both are about *identity*:
 *
 * - **The inbound cookie.** The bound Worker resolves the caller's room from
 *   the session, so a call that arrives without the browser's cookie is a
 *   different caller — at best rejected, at worst answered from some other
 *   room. Its CVR store is not the browser's, so its cookie names a
 *   conversation the browser is not in, and the browser's first pull degrades
 *   to the reset path with nothing surfaced.
 * - **The origin.** The bound Worker sees which front door the request came
 *   through — origin checks, per-origin config, logging. A binding call
 *   carries no origin of its own, so the inbound one is forwarded, and a
 *   relative sync path resolves against the inbound URL.
 *
 * The client group id and the pull cookie need no special handling here: they
 * travel in the protocol bodies (`PullRequest.clientGroupId`,
 * `PullResponse.cookie`), which this carrier moves verbatim. That is the whole
 * CVR conversation, and it is what {@link Transport.ClientTransport} promises.
 *
 * There is no poke channel over a binding: a service binding is
 * request/response, and an SSR render pulls once. `pokes` is empty, which
 * costs nothing — pull is the correctness path (ADR-0008) and pokes are a
 * latency optimization for a long-lived client.
 */

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  TransportError,
  type Transport,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation-effect";
import type { Protocol } from "@thomasfosterau/legation-effect/internal";
import { routes } from "./RoomProtocol.js";

/**
 * The shape of a Cloudflare service binding (`env.API`). Declared structurally
 * so the transport needs no Workers types and a test can pass a plain
 * fetch-alike.
 */
export interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

/**
 * The inbound request being rendered — its cookie and origin are forwarded,
 * and a relative {@link MakeOptions.path} resolves against its URL. A standard
 * `Request` (SvelteKit's `event.request`) satisfies this structurally.
 */
export interface InboundRequest {
  readonly url: string;
  readonly headers: { readonly get: (name: string) => string | null };
}

/** Options for {@link make}. */
export interface MakeOptions {
  /** The service binding to the Worker running the sync server. */
  readonly binding: ServiceBinding;
  /** The inbound SSR request whose cookie and origin are forwarded. */
  readonly request: InboundRequest;
  /**
   * The sync base the bound Worker serves. A path (default `/sync`) resolves
   * against the inbound request's origin; an absolute URL overrides it.
   */
  readonly path?: string;
  /** Extra headers attached to every call (e.g. an internal service token). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The headers a binding call carries over from the inbound request. */
const forwarded = (request: InboundRequest): Record<string, string> => {
  const headers: Record<string, string> = {};
  const cookie = request.headers.get("cookie");
  if (cookie !== null && cookie !== "") headers.cookie = cookie;
  // A top-level navigation usually carries no Origin header; the inbound URL's
  // origin is the front door either way, which is what the bound Worker wants.
  headers.origin = request.headers.get("origin") ?? new URL(request.url).origin;
  return headers;
};

/**
 * Build the transport. Each call is one `binding.fetch` of a JSON POST —
 * no network hop, no public route on the bound Worker.
 */
export const make = (options: MakeOptions): Transport.ClientTransport => {
  const base = new URL(options.path ?? "/sync", options.request.url);
  const carried = forwarded(options.request);
  // Trailing slashes would double up against the protocol's leading-slash routes.
  const prefix = base.href.replace(/\/+$/, "");

  const post =
    <A>(route: string) =>
    (body: unknown): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      Effect.tryPromise({
        try: async () => {
          const response = await options.binding.fetch(
            new Request(`${prefix}${route}`, {
              method: "POST",
              body: JSON.stringify(body),
              headers: { "content-type": "application/json", ...carried, ...options.headers },
            })
          );
          if (!response.ok) {
            const detail = (await response.json().catch(() => ({}))) as { error?: string };
            throw new TransportError({
              message: detail.error ?? `binding ${route} answered ${response.status}`,
            });
          }
          // Trusted JSON from this app's own Worker.
          return (await response.json()) as A;
        },
        catch: (cause) =>
          cause instanceof TransportError
            ? cause
            : new TransportError({ message: `binding ${route} request failed`, cause }),
      });

  return {
    push: post<Protocol.PushResponse>(routes.push),
    pull: post<Protocol.PullResponse>(routes.pull),
    read: post<Protocol.ReadResponse>(routes.read),
    // A binding is request/response: no socket, no pokes. Pull is correctness.
    pokes: Stream.empty,
    status: Effect.succeed("connected"),
    statusChanges: Stream.succeed("connected"),
  };
};
