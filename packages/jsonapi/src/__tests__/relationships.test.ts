/**
 * Relationships tests: resolving JSON:API linkage against the local mirror
 * (to-one and to-many), and that resolution reads live synced state.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ClientEngine, Subset } from "@thomasfosterau/effect-sync-core";
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
  const headers = { "Content-Type": "application/vnd.api+json" };
  const doc = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers });
  const empty = (status: number) => new Response(null, { status, headers });
  const readBody = (request: { readonly body: unknown }): any => {
    const b = request.body as { _tag?: string; body?: Uint8Array };
    return b?._tag === "Uint8Array" && b.body
      ? JSON.parse(new TextDecoder().decode(b.body))
      : undefined;
  };

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const segments = url.pathname.split("/").filter((s) => s.length > 0);
      const type = segments[0]!;
      const id = segments[1];
      let response: Response;
      switch (request.method) {
        case "GET":
          response =
            id === undefined
              ? doc([...store.values()].filter((r) => r.type === type))
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
  return { store, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

const provide = <E>(
  program: Effect.Effect<void, E, ClientEngine.ClientEngine>,
  server: { layer: Layer.Layer<HttpClient.HttpClient> }
) =>
  program.pipe(
    Effect.provide(
      JsonApiSync.layer(api, {
        baseUrl: "http://api.test",
        clientId: "c1",
        clientGroupId: "g1",
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
});
