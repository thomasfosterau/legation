/**
 * Request credentials (ADR-0035, #219): the `IdentityResolver` resolves an
 * identity from the transport request's credentials and client group. The
 * resolver receives them on push, pull and read; header lookup is
 * case-insensitive; a carrier with no request (the in-memory loopback) presents
 * `noCredentials`; and the credentials reach nothing else — not `SyncContext`,
 * middleware or auth filters, nor a log line or a span. A failing resolver
 * still fails the request.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as Authorization from "../Authorization.js";
import { Backend, type SyncContext } from "../Backend.js";
import * as Cvr from "../Cvr.js";
import { AuthorizationError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { makeInMemory } from "../Transport.js";

/** A secret that must reach the resolver and nothing else. */
const SECRET = "session=s3cr3t-token";

const setTodo = Mutator.make("todo/set", Schema.Unknown);
const handlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(setTodo, (args, writer) => writer.put("todos", "t1", args)),
]);

const allTodos = Subset.make({ collection: "todos" });

/** Everything the server's other seams saw, to assert the credentials are absent from it. */
interface Seen {
  readonly requests: ReadonlyArray<Authorization.IdentityRequest>;
  readonly contexts: ReadonlyArray<SyncContext>;
}

/**
 * A sync server whose resolver records each request it gets and whose
 * middleware and auth filter record every `SyncContext` they get.
 */
const makeServer = (resolve?: Authorization.IdentityResolver["resolve"]) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<Authorization.IdentityRequest>>([]);
    const contexts = yield* Ref.make<ReadonlyArray<SyncContext>>([]);
    const record = (context: SyncContext) => Ref.update(contexts, (all) => [...all, context]);
    const identity: Authorization.IdentityResolver = {
      resolve: (request) =>
        Ref.update(requests, (all) => [...all, request]).pipe(
          Effect.andThen(
            resolve === undefined
              ? Effect.succeed(Option.getOrUndefined(request.credentials.header("cookie")))
              : resolve(request)
          )
        ),
    };
    const middleware: Authorization.SyncMiddleware = {
      onPush: (context, request) => Effect.as(record(context), request),
      onPull: (context, request) => Effect.as(record(context), request),
      onRead: (context, request) => Effect.as(record(context), request),
    };
    const filter: Authorization.AuthFilter = (context) =>
      Effect.as(record(context), Authorization.AllowAll);
    const backend = yield* MemoryBackend.make(handlers);
    const handler = yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(Authorization.AuthPolicy, Authorization.policy({ todos: filter })),
      Effect.provideService(Authorization.IdentityResolver, identity),
      Effect.provideService(Authorization.SyncMiddleware, middleware),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
    const seen: Effect.Effect<Seen> = Effect.all(
      { requests: Ref.get(requests), contexts: Ref.get(contexts) },
      { concurrency: 1 }
    );
    return { handler, seen };
  });

const push = {
  clientGroupId: "group-a",
  mutations: [{ clientId: "c1", mutationId: 1, mutator: setTodo.name, args: {}, createdAt: 0 }],
};
const pull = { clientGroupId: "group-a", subscriptions: [allTodos] };
const read = { clientGroupId: "group-a", subsets: [allTodos] };

/** The credentials a carrier presents for a request with a session cookie. */
const presented = {
  credentials: Option.some(Authorization.credentialsFromHeaders({ Cookie: SECRET })),
};

/** The value as JSON, as a log line or a serialised error shows it. */
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Every string a value would show in a log or a serialised error. */
const rendered = (value: unknown): string => `${asJson(value)} ${String(value)}`;

describe("Authorization.credentialsFromHeaders", () => {
  it("looks headers up case-insensitively, from a WHATWG Headers and from a record", () => {
    const fromHeaders = Authorization.credentialsFromHeaders(
      new Headers({ Authorization: "Bearer k1", "X-Api-Key": "k2" })
    );
    expect(fromHeaders.header("authorization")).toEqual(Option.some("Bearer k1"));
    expect(fromHeaders.header("AUTHORIZATION")).toEqual(Option.some("Bearer k1"));
    expect(fromHeaders.header("x-api-key")).toEqual(Option.some("k2"));

    const fromRecord = Authorization.credentialsFromHeaders({ COOKIE: "a=1" });
    expect(fromRecord.header("Cookie")).toEqual(Option.some("a=1"));
    expect(fromRecord.header("authorization")).toEqual(Option.none());
  });

  it("joins a repeated header's parts as HTTP does", () => {
    const credentials = Authorization.credentialsFromHeaders([
      ["Cookie", "a=1"],
      ["cookie", "b=2"],
      ["Accept", "text/html"],
      ["accept", "application/json"],
    ]);
    expect(credentials.header("cookie")).toEqual(Option.some("a=1; b=2"));
    expect(credentials.header("accept")).toEqual(Option.some("text/html, application/json"));
  });

  it("copies the headers, and never prints a value", () => {
    const headers = new Headers({ cookie: SECRET });
    const credentials = Authorization.credentialsFromHeaders(headers);
    headers.set("cookie", "changed");
    expect(credentials.header("cookie")).toEqual(Option.some(SECRET));
    expect(rendered(credentials)).not.toContain("s3cr3t");
    expect(rendered({ nested: credentials })).not.toContain("s3cr3t");
  });

  it("noCredentials carries no header", () => {
    expect(Authorization.noCredentials.header("cookie")).toEqual(Option.none());
    expect(Authorization.noCredentials.header("authorization")).toEqual(Option.none());
  });
});

describe("IdentityResolver sees the request's credentials", () => {
  it.effect("on push, pull and read", () =>
    Effect.gen(function* () {
      const { handler, seen } = yield* makeServer();
      yield* handler.handlePush(push, presented);
      yield* handler.handlePull(pull, presented);
      yield* handler.handleRead(read, presented);

      const { requests } = yield* seen;
      expect(requests.map((request) => request.clientGroupId)).toEqual([
        "group-a",
        "group-a",
        "group-a",
      ]);
      expect(requests.map((request) => request.credentials.header("Cookie"))).toEqual([
        Option.some(SECRET),
        Option.some(SECRET),
        Option.some(SECRET),
      ]);
    }).pipe(Effect.scoped)
  );

  it.effect("absent options or None present noCredentials", () =>
    Effect.gen(function* () {
      const { handler, seen } = yield* makeServer();
      yield* handler.handlePull(pull);
      yield* handler.handleRead(read, { credentials: Option.none() });

      const { requests, contexts } = yield* seen;
      expect(requests.map((request) => request.credentials.header("cookie"))).toEqual([
        Option.none(),
        Option.none(),
      ]);
      // The resolver read no cookie, so the identity is anonymous.
      expect(contexts.every((context) => context.identity === undefined)).toBe(true);
    }).pipe(Effect.scoped)
  );

  it.effect("the in-memory loopback presents noCredentials", () =>
    Effect.gen(function* () {
      const { handler, seen } = yield* makeServer();
      const transport = yield* makeInMemory(handler, "group-a");
      yield* transport.push(push);
      yield* transport.pull(pull);
      const readOver = transport.read;
      expect(readOver).toBeDefined();
      if (readOver !== undefined) yield* readOver(read);

      const { requests } = yield* seen;
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => request.credentials.header("cookie"))).toEqual([
        Option.none(),
        Option.none(),
        Option.none(),
      ]);
    }).pipe(Effect.scoped)
  );

  it.effect("a loopback acting for a request presents that request's credentials", () =>
    Effect.gen(function* () {
      const { handler, seen } = yield* makeServer();
      const transport = yield* makeInMemory(handler, "group-a", presented);
      yield* transport.pull(pull);

      const { requests } = yield* seen;
      expect(requests.map((request) => request.credentials.header("cookie"))).toEqual([
        Option.some(SECRET),
      ]);
    }).pipe(Effect.scoped)
  );
});

describe("credentials reach the resolver alone", () => {
  it.effect(
    "SyncContext, middleware and auth filters get the group and identity, never a credential",
    () =>
      Effect.gen(function* () {
        // The resolver verifies the credential and returns a principal derived
        // from it, never the raw value.
        const { handler, seen } = yield* makeServer((request) =>
          Effect.succeed(
            Option.match(request.credentials.header("cookie"), {
              onNone: () => undefined,
              onSome: (cookie) => (cookie === SECRET ? "alice" : undefined),
            })
          )
        );
        yield* handler.handlePush(push, presented);
        yield* handler.handlePull(pull, presented);
        yield* handler.handleRead(read, presented);

        const { contexts } = yield* seen;
        // onPush, onPull + filter, onRead + filter.
        expect(contexts.length).toBeGreaterThanOrEqual(5);
        // Strict: no key beyond the group and the identity, credentials or otherwise.
        expect(contexts).toStrictEqual(
          contexts.map(() => ({ clientGroupId: "group-a", identity: "alice" }))
        );
      }).pipe(Effect.scoped)
  );

  it.effect("no log line or span the server writes carries a credential", () =>
    Effect.gen(function* () {
      const logged: Array<string> = [];
      const logger = Logger.make((options) => {
        logged.push(
          rendered(options.message),
          rendered(options.fiber.getRef(References.CurrentLogAnnotations))
        );
      });
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const { handler } = yield* makeServer();
      yield* Effect.gen(function* () {
        yield* handler.handlePush(push, presented);
        yield* handler.handlePull(pull, presented);
        yield* handler.handleRead(read, presented);
      }).pipe(Effect.withLogger(logger), Effect.withTracer(tracer));

      expect(spans.length).toBeGreaterThan(0);
      const traced = spans.map((span) => rendered([span.name, [...span.attributes], span.events]));
      expect(traced.filter((text) => text.includes("s3cr3t"))).toEqual([]);
      expect(logged.filter((line) => line.includes("s3cr3t"))).toEqual([]);
    }).pipe(Effect.scoped)
  );
});

describe("a failing resolver", () => {
  it.effect("fails the request, as before", () =>
    Effect.gen(function* () {
      const { handler, seen } = yield* makeServer(() =>
        Effect.fail(new AuthorizationError({ message: "session expired" }))
      );
      const pushed = yield* Effect.flip(handler.handlePush(push, presented));
      const pulled = yield* Effect.flip(handler.handlePull(pull, presented));
      const readFailure = yield* Effect.flip(handler.handleRead(read, presented));

      const failures = [pushed, pulled, readFailure];
      expect(failures.map((failure) => failure._tag)).toEqual([
        "TransportError",
        "TransportError",
        "TransportError",
      ]);
      expect(failures.every((failure) => failure.message.includes("session expired"))).toBe(true);
      expect(failures.some((failure) => rendered(failure).includes("s3cr3t"))).toBe(false);
      // Nothing ran past the resolver.
      expect((yield* seen).contexts).toEqual([]);
    }).pipe(Effect.scoped)
  );
});
