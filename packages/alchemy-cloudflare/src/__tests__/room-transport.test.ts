/**
 * RoomTransport's HTTP tier runs on Effect's Fetch `HttpClient`. Each request is a JSON POST
 * with the app's headers and no trace-propagation headers (a cross-origin room would otherwise
 * need `b3` / `traceparent` in its CORS allowance), and each answer is decoded through the
 * protocol's response schema. The fetch is swapped through `FetchHttpClient.Fetch`, and the poke
 * socket's constructor through `Socket.WebSocketConstructor`, so no global is touched; reconnect
 * backoff runs on the `TestClock`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
      expect(error.message).toBe("room /read answer is invalid");
    })
  );
});

type Listener = (event: Socket.WebSocketEvent) => void;

/** A WebSocket the test opens, messages and drops by hand. */
class FakeSocket implements Socket.WebSocketLike {
  readyState = 0;
  private listeners: ReadonlyArray<readonly [string, Listener]> = [];
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener) {
    this.listeners = [...this.listeners, [type, listener]];
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners = Arr.filter(this.listeners, ([t, l]) => t !== type || l !== listener);
  }
  send() {}
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  message() {
    this.emit("message", { data: "poke" });
  }
  drop() {
    this.close(1006);
  }
  private emit(type: string, event: Socket.WebSocketEvent) {
    Arr.forEach(this.listeners, ([t, listener]) => {
      if (t === type) listener(event);
    });
  }
}

/** Let forked fibres run to their next suspension. */
const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

/** Run `options`' poke stream over fake sockets, counting pokes. */
const runPokes = (options: Partial<RoomTransport.MakeOptions> = {}) =>
  Effect.gen(function* () {
    const sockets: Array<FakeSocket> = [];
    const construct = (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    };
    const pokes = yield* Ref.make(0);
    const fiber = yield* RoomTransport.make({
      url: "https://rooms.example.com/sync",
      ...options,
    }).pokes.pipe(
      Stream.runForEach(() => Ref.update(pokes, (n) => n + 1)),
      Effect.provideService(Socket.WebSocketConstructor, construct),
      Effect.forkChild
    );
    yield* settle;
    const last = () => defined(sockets.at(-1));
    return { sockets, pokes, fiber, last };
  });

/** Advance the clock by `millis` and let the stream react. */
const advance = (millis: number) => Effect.andThen(TestClock.adjust(millis), settle);

describe("RoomTransport poke socket", () => {
  it.effect("dials the socket route, and turns each frame into one poke", () =>
    Effect.gen(function* () {
      const run = yield* runPokes();
      expect(run.sockets.map((socket) => socket.url)).toEqual([
        "wss://rooms.example.com/sync/socket",
      ]);
      run.last().open();
      yield* settle;
      run.last().message();
      run.last().message();
      yield* settle;
      expect(yield* Ref.get(run.pokes)).toBe(2);
      yield* Fiber.interrupt(run.fiber);
      expect(run.last().readyState).toBe(3);
    })
  );

  it.effect("re-dials with linear backoff that restarts once a frame arrives", () =>
    Effect.gen(function* () {
      const run = yield* runPokes();
      run.last().open();
      yield* settle;
      run.last().drop();
      yield* advance(999);
      expect(run.sockets).toHaveLength(1);
      yield* advance(1);
      expect(run.sockets).toHaveLength(2);
      // The second socket never opens: the next wait is two seconds.
      run.last().drop();
      yield* advance(1999);
      expect(run.sockets).toHaveLength(2);
      yield* advance(1);
      expect(run.sockets).toHaveLength(3);
      // A frame on the third socket restarts the backoff at one second.
      run.last().open();
      yield* settle;
      run.last().message();
      yield* settle;
      run.last().drop();
      yield* advance(1000);
      expect(run.sockets).toHaveLength(4);
      expect(yield* Ref.get(run.pokes)).toBe(1);
      yield* Fiber.interrupt(run.fiber);
    })
  );

  it.effect("caps the backoff at maxReconnectDelayMillis", () =>
    Effect.gen(function* () {
      const run = yield* runPokes({ maxReconnectDelayMillis: 1500 });
      run.last().drop();
      yield* advance(1000);
      run.last().drop();
      yield* advance(1499);
      expect(run.sockets).toHaveLength(2);
      yield* advance(1);
      run.last().drop();
      yield* advance(1500);
      expect(run.sockets).toHaveLength(4);
      yield* Fiber.interrupt(run.fiber);
    })
  );

  it.effect("fails with a TransportError once a given reconnect schedule ends", () =>
    Effect.gen(function* () {
      const run = yield* runPokes({ reconnect: Schedule.recurs(1) });
      run.last().drop();
      yield* advance(0);
      run.last().drop();
      yield* advance(0);
      expect(run.sockets).toHaveLength(2);
      const exit = yield* Fiber.await(run.fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = yield* Effect.flip(exit);
      expect(error).toBeInstanceOf(TransportError);
    })
  );
});
