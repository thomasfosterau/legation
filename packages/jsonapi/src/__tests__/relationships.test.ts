/**
 * Relationships tests: resolving JSON:API linkage against the local mirror
 * (to-one and to-many), and that resolution reads live synced state.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema, Scope, Stream, SubscriptionRef } from "effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ClientEngine, Subset } from "@legation/effect/internal";
import type { JsonApiRow } from "../Derive.js";
import * as Relationships from "../Relationships.js";
import * as JsonApiSync from "../JsonApiSync.js";

const idParam = { params: Schema.Struct({ id: Schema.String }) };
const body = { payload: Schema.Unknown, success: Schema.Unknown };
const crud = (type: string) =>
  HttpApiGroup.make(type)
    .add(HttpApiEndpoint.get("list", `/${type}`, { success: Schema.Unknown }))
    .add(HttpApiEndpoint.get("getOne", `/${type}/:id`, { ...idParam, success: Schema.Unknown }))
    .add(HttpApiEndpoint.post("create", `/${type}`, body))
    .add(HttpApiEndpoint.patch("update", `/${type}/:id`, { ...idParam, ...body }))
    .add(HttpApiEndpoint.make("DELETE")("remove", `/${type}/:id`, idParam));

const api = HttpApi.make("app").add(crud("issues")).add(crud("comments")).add(crud("people"));

interface Stored {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
  readonly relationships?: Record<string, unknown>;
}

const makeServer = (seed: ReadonlyArray<Stored>) => {
  const store = new Map(seed.map((r) => [`${r.type}:${r.id}`, r]));
  const requests: Array<string> = [];
  const headers = { "Content-Type": "application/vnd.api+json" };
  const doc = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers });
  const empty = (status: number) => new Response(null, { status, headers });
  const readBody = (request: { readonly body: unknown }): any => {
    const b = request.body as { _tag?: string; body?: Uint8Array };
    return b?._tag === "Uint8Array" && b.body
      ? JSON.parse(new TextDecoder().decode(b.body))
      : undefined;
  };

  const links = (rel: unknown): ReadonlyArray<{ type: string; id: string }> => {
    const data = (rel as { data?: unknown } | undefined)?.data;
    return (data == null ? [] : Array.isArray(data) ? data : [data]) as ReadonlyArray<{
      type: string;
      id: string;
    }>;
  };

  // The grammar's shorthand: `filter[f]=v` (eq), `filter[f]=a,b` (in), or
  // `filter[f][eq|in]=…` — enough for the id windows the engine pushes.
  const list = (type: string, params: URLSearchParams): Response => {
    let rows = [...store.values()].filter((r) => r.type === type);
    for (const [key, value] of params) {
      const match = key.match(/^filter\[([^\]]+)\](?:\[(eq|in)\])?$/);
      if (match === null) continue;
      const field = match[1]!;
      const allowed = value.split(",");
      rows = rows.filter((r) =>
        field === "id" ? allowed.includes(r.id) : allowed.includes(String(r.attributes[field]))
      );
    }
    const include = params.get("include");
    if (include === null) return doc(rows);
    const seen = new Map<string, Stored>();
    for (const r of rows) {
      for (const name of include.split(",")) {
        for (const link of links(r.relationships?.[name])) {
          const target = store.get(`${link.type}:${link.id}`);
          if (target !== undefined) seen.set(`${link.type}:${link.id}`, target);
        }
      }
    }
    return new Response(JSON.stringify({ data: rows, included: [...seen.values()] }), {
      status: 200,
      headers,
    });
  };

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.pathname + url.search);
      const segments = url.pathname.split("/").filter((s) => s.length > 0);
      const type = segments[0]!;
      const id = segments[1];
      let response: Response;
      switch (request.method) {
        case "GET":
          response =
            id === undefined
              ? list(type, url.searchParams)
              : store.has(`${type}:${id}`)
                ? doc(store.get(`${type}:${id}`))
                : empty(404);
          break;
        case "POST": {
          const resource = readBody(request).data as Stored;
          store.set(`${type}:${resource.id}`, {
            ...resource,
            attributes: resource.attributes ?? {},
          });
          response = doc(store.get(`${type}:${resource.id}`));
          break;
        }
        case "PATCH": {
          const patch = readBody(request).data as Stored;
          const existing = store.get(`${type}:${id}`) ?? { type, id: id!, attributes: {} };
          const merged = {
            ...existing,
            attributes: { ...existing.attributes, ...patch.attributes },
          };
          store.set(`${type}:${id}`, merged);
          response = doc(merged);
          break;
        }
        case "DELETE":
          store.delete(`${type}:${id}`);
          response = empty(204);
          break;
        default:
          response = empty(405);
      }
      return HttpClientResponse.fromWeb(request, response);
    })
  );
  return { store, requests, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

const provide = <E>(
  program: Effect.Effect<void, E, ClientEngine.ClientEngine | Scope.Scope>,
  server: { layer: Layer.Layer<HttpClient.HttpClient> },
  options?: { readonly includes?: Readonly<Record<string, ReadonlyArray<string>>> }
) =>
  program.pipe(
    Effect.provide(
      JsonApiSync.layer(api, {
        baseUrl: "http://api.test",
        clientId: "c1",
        clientGroupId: "g1",
        ...(options?.includes !== undefined ? { includes: options.includes } : {}),
      }).pipe(Layer.provide(server.layer))
    ),
    Effect.scoped
  );

const attr = (value: JsonApiRow | undefined, key: string): unknown => value?.[key];

describe("Relationships", () => {
  const issues = Subset.make({ collection: "issues" });

  const seed: ReadonlyArray<Stored> = [
    {
      type: "issues",
      id: "i1",
      attributes: { title: "Bug" },
      relationships: {
        author: { data: { type: "people", id: "p1" } },
        comments: {
          data: [
            { type: "comments", id: "c1" },
            { type: "comments", id: "c2" },
          ],
        },
      },
    },
    { type: "people", id: "p1", attributes: { name: "Ada" } },
    { type: "comments", id: "c1", attributes: { body: "first" } },
    { type: "comments", id: "c2", attributes: { body: "second" } },
  ];

  const syncAll = (engine: ClientEngine.ClientEngine) =>
    Effect.gen(function* () {
      yield* engine.subscribe(issues);
      yield* engine.subscribe(Subset.make({ collection: "comments" }));
      yield* engine.subscribe(Subset.make({ collection: "people" }));
      yield* engine.pull;
    });

  it.effect("resolves to-one and to-many relationships from the mirror", () => {
    const server = makeServer(seed);
    return provide(
      Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        yield* syncAll(engine);

        const rows = yield* Relationships.query(engine, issues, ["author", "comments"]);
        expect(rows).toHaveLength(1);
        const issue = rows[0]!;
        expect(attr(issue.related.author as JsonApiRow, "name")).toBe("Ada");
        const comments = issue.related.comments as ReadonlyArray<JsonApiRow>;
        expect(comments.map((c) => attr(c, "body"))).toEqual(["first", "second"]);
      }),
      server
    );
  });

  it.effect("re-resolves against live state after a referenced row changes", () => {
    const server = makeServer(seed);
    return provide(
      Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        yield* syncAll(engine);

        // observe's first emission matches a one-shot query.
        const first = yield* Stream.runHead(Relationships.observe(engine, issues, ["comments"]));
        const initial = (first._tag === "Some" ? first.value : [])[0]!;
        expect(
          (initial.related.comments as ReadonlyArray<JsonApiRow>).map((c) => attr(c, "body"))
        ).toEqual(["first", "second"]);

        // Editing a referenced comment is reflected in the resolved join.
        yield* engine.mutate("comments/update", {
          type: "comments",
          id: "c1",
          attributes: { body: "edited" },
        });
        yield* engine.push;
        yield* engine.pull;

        const rows = yield* Relationships.query(engine, issues, ["comments"]);
        expect(
          (rows[0]!.related.comments as ReadonlyArray<JsonApiRow>).map((c) => attr(c, "body"))
        ).toEqual(["edited", "second"]);
      }),
      server
    );
  });

  // Real-clock test: a forked observer collects the join's emissions while a
  // referenced (not base) row is edited, proving the live join re-emits
  // incrementally without the base subset changing.
  it("re-emits the join incrementally when a referenced row changes", async () => {
    const server = makeServer(seed);
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const engine = yield* ClientEngine.ClientEngine;
          yield* syncAll(engine);

          const bodiesOf = (rows: ReadonlyArray<Relationships.RelatedRow>) =>
            (rows[0]!.related.comments as ReadonlyArray<JsonApiRow>).map((c) => attr(c, "body"));
          const seen = yield* SubscriptionRef.make<ReadonlyArray<ReadonlyArray<unknown>>>([]);
          // Wait on the observer's emissions, not on wall-clock time.
          const emitted = (until: (emissions: ReadonlyArray<ReadonlyArray<unknown>>) => boolean) =>
            SubscriptionRef.changes(seen).pipe(Stream.filter(until), Stream.runHead);
          yield* Effect.forkScoped(
            Stream.runForEach(Relationships.observe(engine, issues, ["comments"]), (rows) =>
              SubscriptionRef.update(seen, (acc) => [...acc, bodiesOf(rows)])
            )
          );
          yield* emitted((emissions) => emissions.length > 0);

          // Edit a referenced comment only — the base `issues` row is untouched.
          yield* engine.mutate("comments/update", {
            type: "comments",
            id: "c1",
            attributes: { body: "edited" },
          });
          yield* engine.push;
          yield* engine.pull;
          // The pulled (authoritative) join carries the edit...
          const settled = bodiesOf(yield* Relationships.query(engine, issues, ["comments"]));
          expect(settled).toEqual(["edited", "second"]);
          // ...and the observer re-emits it. Its emissions can lag the pull
          // (and a push ack briefly re-emits the pre-edit join, #286), so wait
          // for the latest one to match rather than reading a snapshot.
          const emissions = Option.getOrThrow(
            yield* emitted(
              (acc) => acc.length >= 2 && JSON.stringify(acc.at(-1)) === JSON.stringify(settled)
            )
          );
          expect(emissions[0]).toEqual(["first", "second"]);
          expect(emissions[emissions.length - 1]).toEqual(["edited", "second"]);
          expect(emissions.length).toBeGreaterThanOrEqual(2);
        }),
        server
      )
    );
  }, 10000);

  it.effect("auto-subscribes the referenced collections (narrowed by id)", () => {
    const server = makeServer(seed);
    return provide(
      Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        // No manual subscribe of comments/people — related() does it.
        const stream = yield* Relationships.related(engine, issues, ["author", "comments"]);
        const head = yield* Stream.runHead(stream);
        const issue = (head._tag === "Some" ? head.value : [])[0]!;

        expect(attr(issue.related.author as JsonApiRow, "name")).toBe("Ada");
        expect(
          (issue.related.comments as ReadonlyArray<JsonApiRow>).map((c) => attr(c, "body"))
        ).toEqual(["first", "second"]);
        // The referenced collections were fetched narrowed to the linked ids,
        // in the grammar's canonical form (`in` over a list; a one-id list
        // takes the operator form so it decodes back as `in`, not `eq`).
        expect(server.requests).toContain("/comments?filter[id]=c1%2Cc2");
        expect(server.requests).toContain("/people?filter[id][in]=p1");
      }),
      server
    );
  });

  it.effect("include delivers related rows in the parent response (no extra round trip)", () => {
    const server = makeServer(seed);
    return provide(
      Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        const stream = yield* Relationships.related(engine, issues, ["author", "comments"]);
        const head = yield* Stream.runHead(stream);
        const issue = (head._tag === "Some" ? head.value : [])[0]!;

        expect(
          (issue.related.comments as ReadonlyArray<JsonApiRow>).map((c) => attr(c, "body"))
        ).toEqual(["first", "second"]);
        expect(attr(issue.related.author as JsonApiRow, "name")).toBe("Ada");

        // Parent listing carried `include`; the related collections were served
        // from the harvested compound document, never fetched on their own.
        expect(
          server.requests.some((u) => u.startsWith("/issues?") && u.includes("include="))
        ).toBe(true);
        expect(server.requests.some((u) => u.startsWith("/comments"))).toBe(false);
        expect(server.requests.some((u) => u.startsWith("/people"))).toBe(false);
      }),
      server,
      { includes: { issues: ["author", "comments"] } }
    );
  });
});
