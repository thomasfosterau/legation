/**
 * JsonApiFacade mutation status URL tests (#511, ADR-0030 §2):
 * `{prefix}/_legation/mutations/{mutationId}`, answered from the engine's
 * mutation-state map and never forwarded — `200` with the phase per
 * mutation, `404 unknown_mutation` for an id the map does not hold, and
 * `Prefer: wait=N` holding a pending answer for its ruling, up to a cap.
 *
 * The fixture is `json-api-facade-writes.test.ts`'s: a `MemoryBackend`
 * behind a `Server` whose handlers are the graph-derived CRUD mutations
 * (plus a rule that refuses a note titled "reject"), synced into an owned
 * engine. Writes are journaled offline through the façade, so each test
 * reaches the status route through a receipt's `Location`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as TestClock from "effect/testing/TestClock";
import {
  Authorization,
  Client,
  ClientStore,
  CrudMutation,
  MemoryBackend,
  Mutation,
  MutationRejected,
  Node,
  Server,
  Transport,
} from "@thomasfosterau/legation-effect";
import { ClientEngine, ClientView, MutationState } from "@thomasfosterau/legation-effect/internal";
import * as JsonApiFacade from "../JsonApiFacade.js";
import * as JsonApiQuery from "../JsonApiQuery.js";

// ─── The graph, its api and the server ───────────────────────────────────────

const notes = Node.make("notes", { attributes: { title: Schema.String } });
const nodes = Node.registry([notes]);

const open = { success: Schema.Unknown };
const idParam = { params: Schema.Struct({ id: Schema.String }), ...open };
const api = HttpApi.make("notebook")
  .add(
    HttpApiGroup.make("notebook")
      .add(HttpApiEndpoint.get("notes", "/notes", open))
      .add(HttpApiEndpoint.post("createNote", "/notes", open))
      .add(HttpApiEndpoint.delete("deleteNote", "/notes/:id", idParam))
  )
  .prefix("/jsonapi");

const GROUP = "group-s";
const crud = CrudMutation.entries(nodes);

const Title = Schema.Struct({
  attributes: Schema.Struct({ title: Schema.optional(Schema.String) }),
});

/** The server's handlers: the derived mutations, and one rule a note titled "reject" breaks. */
const serverHandlers = R.fromEntries(
  Arr.map(
    crud,
    (entry) =>
      [
        entry.mutator.name,
        (args: unknown, writer: MemoryBackend.BackendWriter) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.orDie(Schema.decodeUnknownEffect(Title)(args));
            if (decoded.attributes.title === "reject") {
              return yield* new MutationRejected({ reason: "title refused" });
            }
            yield* Effect.orDie(entry.local(args, writer));
          }),
      ] as const
  )
);

// ─── Fixture ─────────────────────────────────────────────────────────────────

interface Fixture {
  readonly handler: JsonApiFacade.FetchHandler;
  readonly engine: ClientEngine.ClientEngine;
  /** A second engine over the same store, as a restarted worker boots, with its own façade. */
  readonly restart: Effect.Effect<JsonApiFacade.FetchHandler, never, Scope.Scope>;
}

const makeFixture = (
  options: {
    readonly maxTerminal?: number;
    readonly maxWait?: JsonApiFacade.Options<string, never>["maxWait"];
  } = {}
): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(serverHandlers);
    const server = yield* Server.make({
      backend,
      auth: {
        policy: Authorization.policy(
          { notes: Authorization.allowAll },
          { collections: nodes.collections }
        ),
      },
    });
    const transport = yield* Transport.makeInMemory(server.handler, GROUP);
    const store = yield* ClientStore.makeMemory;
    const boot = Effect.gen(function* () {
      const engine = yield* ClientEngine.make({
        clientId: "client-s",
        clientGroupId: GROUP,
        mutators: Mutation.registry(crud),
        mutationStateRetention: {
          maxTerminal: options.maxTerminal ?? MutationState.DEFAULT_MAX_TERMINAL,
        },
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );
      const client = Client.fromView(nodes, ClientView.fromEngine(engine), {
        urls: JsonApiQuery.urlReads(nodes),
      });
      const handler = JsonApiFacade.fetchHandler({
        nodes,
        api,
        view: client.view,
        coverageOf: client.coverageOf,
        cookie: store.getCookie,
        online: () => false,
        mutate: engine.mutateWithAck,
        mutationStates: engine.mutationStates,
        maxWait: options.maxWait ?? "30 seconds",
      });
      return { engine, handler };
    }).pipe(Effect.orDie);
    const { engine, handler } = yield* boot;
    return { engine, handler, restart: Effect.map(boot, (booted) => booted.handler) };
  });

// ─── Requests ────────────────────────────────────────────────────────────────

const MEDIA = "application/vnd.api+json";
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const createNote = (id: string, title: string) =>
  new Request(new URL("/jsonapi/notes", "http://notes.test"), {
    method: "POST",
    headers: { accept: MEDIA, "content-type": MEDIA },
    body: toJson({ data: { type: "notes", id, attributes: { title } } }),
  });

const status = (path: string, headers: Record<string, string> = {}) =>
  new Request(new URL(path, "http://notes.test"), { headers: { accept: MEDIA, ...headers } });

const body = (response: Response): Effect.Effect<any> =>
  Effect.orDie(Effect.tryPromise(() => response.json()));

const answer = (handler: JsonApiFacade.FetchHandler, request: Request): Effect.Effect<Response> =>
  Effect.flatMap(handler.handle(request), (response) =>
    response === undefined
      ? Effect.die(`forwarded: ${request.method} ${request.url}`)
      : Effect.succeed(response)
  );

/** Journal a create through the façade and return its receipt's `Location`. */
const journal = (handler: JsonApiFacade.FetchHandler, id: string, title: string) =>
  Effect.gen(function* () {
    const response = yield* answer(handler, createNote(id, title));
    expect(response.status).toBe(202);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    return location ?? "";
  });

/** The façade-synthesised headers every status response carries. */
const expectHeaders = (response: Response) => {
  expect(response.headers.get("content-type")).toBe(MEDIA);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get(JsonApiFacade.servedAtHeader)).not.toBeNull();
};

const expectUnknown = (response: Response, document: any) => {
  expect(response.status).toBe(404);
  expectHeaders(response);
  expect(document.errors[0]).toMatchObject({ status: "404", code: "unknown_mutation" });
  expect(document.errors[0].detail).toContain("cannot be told apart");
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("JsonApiFacade: the mutation status URL", () => {
  it.effect("a receipt's Location resolves to the status of a pending mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        const request = status(location);
        expect(handler.matches(request)).toBe(true);
        const response = yield* answer(handler, request);
        expect(response.status).toBe(200);
        expectHeaders(response);
        const document = yield* body(response);
        const mutationId = location.split("/").at(-1);
        expect(document.data).toEqual({
          type: "legation-mutations",
          id: mutationId,
          attributes: {
            phase: "pending",
            mutator: "notes/create",
            journaledAt: expect.any(Number),
          },
          links: { self: location, resource: "/jsonapi/notes/n-1" },
        });
      })
    )
  );

  it.effect("an acknowledged mutation answers its phase and when it settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, engine } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        yield* engine.push;
        const document = yield* body(yield* answer(handler, status(location)));
        expect(document.data.attributes).toEqual({
          phase: "acknowledged",
          mutator: "notes/create",
          journaledAt: expect.any(Number),
          settledAt: expect.any(Number),
        });
      })
    )
  );

  it.effect("a rejected mutation answers the push's rejection reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, engine } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "reject");
        yield* engine.push;
        const document = yield* body(yield* answer(handler, status(location)));
        expect(document.data.attributes).toMatchObject({
          phase: "rejected",
          reason: "title refused",
          settledAt: expect.any(Number),
        });
      })
    )
  );

  it.effect("a dropped mutation answers `dropped`", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Façade writes are never paced; a dropped entry is a paced compaction's, read as is.
        const { handler, engine } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        const mutationId = Number(location.split("/").at(-1));
        // Pacing drops a pending entry from the journal; the map shows `dropped`.
        const compaction = yield* Effect.orDie(engine.dropIfPending([mutationId]));
        expect(compaction.dropped).toEqual([mutationId]);
        const document = yield* body(yield* answer(handler, status(location)));
        expect(document.data.attributes.phase).toBe("dropped");
      })
    )
  );

  it.effect("a pending mutation survives a worker restart: the journal seeds the map", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, restart } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        const restarted = yield* restart;
        const document = yield* body(yield* answer(restarted, status(location)));
        expect(document.data.attributes.phase).toBe("pending");
      })
    )
  );

  it.effect(
    "an id the map does not hold is 404 unknown_mutation, settled beyond maxTerminal too",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler, engine } = yield* makeFixture({ maxTerminal: 1 });
          const first = yield* journal(handler, "n-1", "One");
          const second = yield* journal(handler, "n-2", "Two");
          yield* engine.push;
          // The older settled entry is evicted beyond the retention window.
          const evicted = yield* answer(handler, status(first));
          expectUnknown(evicted, yield* body(evicted));
          expect((yield* answer(handler, status(second))).status).toBe(200);
          // Never journaled, and not an id at all.
          yield* Effect.forEach(
            ["/jsonapi/_legation/mutations/99", "/jsonapi/_legation/mutations/x"],
            (path) =>
              Effect.flatMap(answer(handler, status(path)), (response) =>
                Effect.map(body(response), (document) => expectUnknown(response, document))
              ),
            { concurrency: 1, discard: true }
          );
        })
      )
  );

  it.effect("only the status route under a reflected prefix is the façade's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFixture();
        expect(handler.matches(status("/other/_legation/mutations/1"))).toBe(false);
        expect(handler.matches(status("/jsonapi/_legation/mutations"))).toBe(false);
        expect(
          handler.matches(
            new Request("http://notes.test/jsonapi/_legation/mutations/1", {
              headers: { accept: "*/*" },
            })
          )
        ).toBe(false);
      })
    )
  );
});

describe("JsonApiFacade: Prefer: wait on the status URL", () => {
  it.effect("holds a pending answer until the mutation settles inside the window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, engine } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        const held = yield* Effect.forkScoped(
          answer(handler, status(location, { prefer: "wait=10" }))
        );
        yield* TestClock.adjust("1 second");
        yield* engine.push;
        const response = yield* Fiber.join(held);
        expect(response.headers.get("preference-applied")).toBe("wait=10");
        expect((yield* body(response)).data.attributes.phase).toBe("acknowledged");
      })
    )
  );

  it.effect("answers still pending once the wait elapses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        const held = yield* Effect.forkScoped(
          answer(handler, status(location, { prefer: "wait=5" }))
        );
        yield* TestClock.adjust("5 seconds");
        const response = yield* Fiber.join(held);
        expect(response.headers.get("preference-applied")).toBe("wait=5");
        expect((yield* body(response)).data.attributes.phase).toBe("pending");
      })
    )
  );

  it.effect("caps the wait at the façade's maxWait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFixture({ maxWait: "2 seconds" });
        const location = yield* journal(handler, "n-1", "Plan");
        const held = yield* Effect.forkScoped(
          answer(handler, status(location, { prefer: "wait=60" }))
        );
        yield* TestClock.adjust("2 seconds");
        const response = yield* Fiber.join(held);
        expect(response.headers.get("preference-applied")).toBe("wait=2");
        expect((yield* body(response)).data.attributes.phase).toBe("pending");
      })
    )
  );

  it.effect("a settled mutation answers at once, with no Preference-Applied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, engine } = yield* makeFixture();
        const location = yield* journal(handler, "n-1", "Plan");
        yield* engine.push;
        const response = yield* answer(handler, status(location, { prefer: "wait=10" }));
        expect(response.headers.get("preference-applied")).toBeNull();
        expect((yield* body(response)).data.attributes.phase).toBe("acknowledged");
      })
    )
  );
});
