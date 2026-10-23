/**
 * The commerce app as a browser sees it, for the façade's browser test
 * (#168): one origin serving the SvelteKit production build — its pages,
 * assets, the service worker and the read proxy — in front of the sync
 * server (WebSocket + HTTP carriers and the derived JSON:API), both
 * in-process on ephemeral ports over one temporary SQLite file, exactly
 * the deployment `pnpm run dev:server` + `pnpm run preview` stand up by hand
 * with a reverse proxy in front.
 *
 * - The sync server is `server/main.ts`'s composition on port 0 (no
 *   fulfilment worker, no polling hint source: nothing writes out of band
 *   here), with the REST tier's backend wrapped to count its calls, so a
 *   test can assert the server was never asked for a locally served URL.
 * - The app is `vite build` (adapter-node), made once per Vitest run by
 *   the `commerce-browser` project's global setup before the test files
 *   start (`build.ts`, #289), whose `handler` is mounted on the front
 *   server in-process — `SYNC_ORIGIN`, `PROTOCOL_HEADER`, `COMMERCE_DB` and
 *   the Better Auth secret are set before the build's modules load, which
 *   is when they read them. adapter-node 6 takes the app's origin from the
 *   request (`Host`, and the protocol from the `PROTOCOL_HEADER`, else
 *   `https`), so the front, as a reverse proxy would, names `http`.
 * - The front routes `/sync*` (the carriers, WebSocket upgrades included)
 *   to the sync server and everything else to the app, so the browser
 *   talks one origin, as it does behind a real reverse proxy or the dev
 *   server's proxy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inject } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpSyncServer } from "@thomasfosterau/legation-node";
import { clientLayer, migrate } from "../../server/db.js";
import { jsonApiLive } from "../../server/jsonapi.js";
import { CommerceSync, syncLayer } from "../../server/runtime.js";
import { appDir as app } from "./build.js";
import { type Calls, countedBackend } from "./counted.js";

export interface App {
  /** The browser's origin: the front serving the app and proxying the carriers. */
  readonly origin: string;
  /** The sync server's SQL client — the authoritative tables, for assertions. */
  readonly sql: SqlClient;
  /** How many times the derived REST handlers asked the backend for rows so far. */
  readonly restCalls: () => number;
  /**
   * Cut the sync carriers: while down, the carriers' requests and upgrades
   * are dropped at the socket, and every tunnel and forwarded request
   * already in flight is destroyed, so the worker's engine can neither push
   * nor pull. The browser's own offline emulation does not reach the
   * worker's WebSocket, which stays open under `context.setOffline` — this
   * is the transport half of "offline" for the sync path.
   */
  readonly carriers: (up: boolean) => void;
  /**
   * Cut the app's upstream: while on, every request but the carriers' is
   * dropped at the socket, so a forward from the worker rejects at the
   * transport while the browser still reads online — ADR-0029 §4's second
   * half of "offline", which browser-side network emulation does not reach
   * (the worker's own fetches still go out under `context.setOffline`).
   */
  readonly blackout: (on: boolean) => void;
  readonly close: () => Promise<void>;
}

type KitHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * Check the run built the app: `global-setup.ts` provides the outcome, so a
 * failed build fails here with its output, and a run that skipped the setup
 * fails rather than serving whatever `build/` holds.
 */
const requireBuild = () => {
  const build = inject("commerceBuild");
  if (build === undefined) {
    throw new Error(
      "examples/commerce was not built for this run: run the browser test through the root " +
        "vitest config's `commerce-browser` project, whose global setup builds the app."
    );
  }
  if (build._tag === "Failed") throw new Error(build.message);
};

/** The sync server on an ephemeral port, its REST reads counted. */
const syncServer = (dbPath: string, calls: Calls) => {
  const counted = Layer.effect(CommerceSync)(
    Effect.map(CommerceSync, (sync) => countedBackend(sync, calls))
  );
  const carriers = Layer.mergeAll(
    HttpSyncServer.layerWebSocket({ path: "/sync-ws" }),
    HttpSyncServer.layerHttp({ path: "/sync" })
  );
  const database = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(clientLayer(dbPath)));
  // The api's layer types leak an `unknown` requirement (effect-jsonapi's
  // handler declarations; `tests/support/world.ts` narrows the same way).
  return HttpRouter.serve(Layer.mergeAll(carriers, jsonApiLive.pipe(Layer.provide(counted))), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provideMerge(syncLayer),
    Layer.provideMerge(database)
  ) as Layer.Layer<HttpServer.HttpServer | SqlClient, unknown>;
};

/** A connection the front holds open for a carrier, so a cut can destroy it. */
interface Closable {
  destroy(): void;
}

/** Forward a plain request to the sync server, response streamed back. */
const forward = (req: IncomingMessage, res: ServerResponse, port: number, open: Set<Closable>) => {
  const upstream = httpRequest(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    }
  );
  open.add(upstream);
  upstream.on("close", () => open.delete(upstream));
  upstream.on("error", () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(upstream);
};

/** Tunnel a WebSocket upgrade to the sync server: the raw request, then both sockets piped. */
const tunnel = (
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  port: number,
  open: Set<Closable>
) => {
  open.add(socket);
  const upstream = connect(port, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      raw += `${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}\r\n`;
    }
    upstream.write(`${raw}\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  open.add(upstream);
  // Either end closing closes the other, so the sync server never keeps a
  // WebSocket whose browser end is gone (#522).
  socket.on("close", () => {
    open.delete(socket);
    upstream.destroy();
  });
  upstream.on("close", () => {
    open.delete(upstream);
    socket.destroy();
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

/** Serve the run's build of the app; `close` tears everything down. */
export const serveApp = async (): Promise<App> => {
  requireBuild();
  const dir = mkdtempSync(join(tmpdir(), "legation-commerce-"));
  const dbPath = join(dir, "commerce.db");
  const calls: Calls = { n: 0 };

  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.build(syncServer(dbPath, calls)).pipe(Scope.provide(scope))
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") throw new Error("expected the sync server on a TCP port");
  const syncPort = address.port;

  // The front: the app's handler once loaded, the carriers proxied.
  let handler: KitHandler | undefined;
  let blackout = false;
  let carriersUp = true;
  const open = new Set<Closable>();
  const front = createServer((req, res) => {
    if (req.url?.startsWith("/sync")) {
      if (!carriersUp) return req.socket.destroy();
      return forward(req, res, syncPort, open);
    }
    if (blackout) return req.socket.destroy();
    if (handler === undefined) {
      res.statusCode = 503;
      return res.end("app not loaded");
    }
    req.headers["x-forwarded-proto"] = "http";
    handler(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });
  front.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/sync") && carriersUp) tunnel(req, socket, head, syncPort, open);
    else socket.destroy();
  });
  const origin = `http://127.0.0.1:${await listen(front)}`;

  // The build's server modules read their environment when they load.
  process.env.SYNC_ORIGIN = `http://127.0.0.1:${syncPort}`;
  process.env.PROTOCOL_HEADER = "x-forwarded-proto";
  process.env.COMMERCE_DB = dbPath;
  process.env.BETTER_AUTH_SECRET = "commerce-browser-test";
  process.env.BETTER_AUTH_URL = origin;
  const built = (await import(pathToFileURL(join(app, "build/handler.js")).href)) as {
    handler: KitHandler;
  };
  handler = built.handler;

  return {
    origin,
    sql: Context.get(context, SqlClient),
    restCalls: () => calls.n,
    carriers: (up) => {
      carriersUp = up;
      if (!up) for (const connection of open) connection.destroy();
    },
    blackout: (on) => {
      blackout = on;
    },
    close: async () => {
      // The carriers' tunnels and forwards first: `closeAllConnections`
      // reaches neither an upgraded socket nor the front's own connections
      // to the sync server, and one left open holds the sync server's
      // shutdown for its whole 20 s graceful-shutdown bound (#522).
      for (const connection of open) connection.destroy();
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      // Closing the scope interrupts the server fibers; an interruption-only
      // exit is the shutdown, anything else a defect worth surfacing.
      const exit = await Effect.runPromiseExit(Scope.close(scope, Exit.void));
      if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) {
        throw Cause.squash(exit.cause);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
