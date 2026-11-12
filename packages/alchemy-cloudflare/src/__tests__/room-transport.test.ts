/**
 * RoomTransport's HTTP tier runs on Effect's Fetch `HttpClient` (#562). Each request is a JSON POST
 * with the app's headers and no trace-propagation headers (a cross-origin room would otherwise
 * need `b3` / `traceparent` in its CORS allowance), and each answer is decoded through the
 * protocol's response schema. The fetch is swapped through `FetchHttpClient.Fetch`, so no global
 * is touched.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TransportError } from "@thomasfosterau/legation";
import * as RoomTransport from "../RoomTransport.js";
import { defined } from "./defined.js";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A fetch that records each request into `sent` and answers `respond`'s response. */
const recordingFetch =
  (sent: Array<Sent>, respond: () => Response): typeof globalThis.fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    sent.push({ url: request.url, method: request.method, headers: request.headers, body });
    return respond();
  };

const transport = RoomTransport.make({
  url: "https://rooms.example.com/sync",
  headers: { authorization: "Bearer session" },
});

describe("RoomTransport HTTP", () => {
  it.effect("posts JSON with the app's headers and no trace headers, and decodes the answer", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = [];
      const fetch = recordingFetch(sent, () => Response.json({ lastMutationIds: { c1: 3 } }));
      const request = { clientGroupId: "g1", mutations: [] };
      const response = yield* transport
        .push(request)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.withSpan("caller"));
      expect(response).toEqual({ lastMutationIds: { c1: 3 } });
      const [only] = sent;
      const one = defined(only);
      expect(one.url).toBe("https://rooms.example.com/sync/push");
      expect(one.method).toBe("POST");
      expect(one.headers.get("content-type")).toBe("application/json");
      expect(one.headers.get("authorization")).toBe("Bearer session");
      expect(one.headers.has("traceparent")).toBe(false);
      expect(one.headers.has("b3")).toBe(false);
      expect(one.body).toEqual(request);
    })
  );

  it.effect("a non-2xx answer fails with the room's stated error", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = [];
      const fetch = recordingFetch(sent, () =>
        Response.json({ error: "bad cookie" }, { status: 400 })
      );
      const exit = yield* transport
        .pull({ clientGroupId: "g1", subscriptions: [] })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.exit);
      expect(exit).toEqual(Exit.fail(new TransportError({ message: "bad cookie" })));
    })
  );

  it.effect("a non-2xx answer without a JSON error names the route and status", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = [];
      const fetch = recordingFetch(sent, () => new Response("down", { status: 503 }));
      const exit = yield* defined(transport.read)({ clientGroupId: "g1", subsets: [] }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.exit
      );
      expect(exit).toEqual(Exit.fail(new TransportError({ message: "room /read answered 503" })));
    })
  );

  it.effect("an answer that is not the protocol's response fails as a TransportError", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = [];
      const fetch = recordingFetch(sent, () => Response.json({ rows: "nope" }));
      const error = yield* defined(transport.read)({ clientGroupId: "g1", subsets: [] }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.flip
      );
      expect(error).toBeInstanceOf(TransportError);
      expect(error.message).toBe("room /read request failed");
    })
  );
});
