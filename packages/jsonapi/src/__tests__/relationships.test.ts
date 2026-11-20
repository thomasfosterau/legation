/**
 * Relationships tests: resolving JSON:API linkage against the local mirror
 * (to-one and to-many), and that resolution reads live synced state.
 */
import { assert, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { Predicate } from "@thomasfosterau/legation";
import { ClientEngine, Subset, Defined } from "@thomasfosterau/legation/internal";
import { RowSchema, type JsonApiRow } from "../Derive.js";
import * as Relationships from "../Relationships.js";
import * as JsonApiSync from "../JsonApiSync.js";
import { defined } from "./defined.js";
import { withLayer } from "./with-layer.js";

const decodeRow = Schema.decodeUnknownSync(RowSchema);
const decodeRows = Schema.decodeUnknownSync(Schema.Array(RowSchema));

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonText);

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
  readonly attributes: Record<string, Predicate.Literal>;
  readonly relationships?: Record<string, Schema.Json>;
}

const decodeResourceDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        type: Schema.String,
        id: Schema.String,
        attributes: Schema.optionalKey(
          Schema.Record(
            Schema.String,
            Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
          )
        ),
        relationships: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      }),
    })
  )
);
/** The primary resource of a request's JSON:API document. */
const readResource = (request: HttpClientRequest.HttpClientRequest) =>
  decodeResourceDocument(
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
  ).data;

const decodeLinkage = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ type: Schema.String, id: Schema.String }))
);
const links = (rel: unknown) => {
  const data = P.hasProperty(rel, "data") ? rel.data : undefined;
  return decodeLinkage(data == null ? [] : Array.isArray(data) ? data : [data]);
};

const makeServer = (seed: ReadonlyArray<Stored>) => {
  const store = new Map(seed.map((r) => [`${r.type}:${r.id}`, r]));
  const requests: Array<string> = [];
  const headers = { "Content-Type": "application/vnd.api+json" };
  const doc = (data: unknown) => new Response(encodeJson({ data }), { status: 200, headers });
  const empty = (status: number) => new Response(null, { status, headers });

  // The grammar's shorthand: `filter[f]=v` (eq), `filter[f]=a,b` (in), or
  // `filter[f][eq|in]=…` — enough for the id windows the engine pushes.
  const list = (type: string, params: URLSearchParams): Response => {
    let rows = [...store.values()].filter((r) => r.type === type);
    Arr.forEach(params, ([key, value]) => {
      const match = key.match(/^filter\[([^\]]+)\](?:\[(eq|in)\])?$/);
      if (match === null) return;
      const field = defined(match[1]);
      const allowed = value.split(",");
      rows = rows.filter((r) =>
        field === "id" ? allowed.includes(r.id) : allowed.includes(String(r.attributes[field]))
      );
    });
    const include = params.get("include");
    if (include === null) return doc(rows);
    const seen = new Map<string, Stored>();
    Arr.forEach(rows, (r) => {
      Arr.forEach(include.split(","), (name) => {
        Arr.forEach(links(r.relationships?.[name]), (link) => {
          const target = store.get(`${link.type}:${link.id}`);
          if (target !== undefined) seen.set(`${link.type}:${link.id}`, target);
        });
      });
    });
    return new Response(encodeJson({ data: rows, included: [...seen.values()] }), {
      status: 200,
      headers,
    });
  };

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.pathname + url.search);
      const segments = url.pathname.split("/").filter((s) => Str.isNonEmpty(s));
      const type = defined(segments[0]);
      const id = segments[1];
      const response: Response = Match.value(request.method).pipe(
        Match.withReturnType<Response>(),
        Match.when("GET", () =>
          id === undefined
            ? list(type, url.searchParams)
            : store.has(`${type}:${id}`)
              ? doc(store.get(`${type}:${id}`))
              : empty(404)
        ),
        Match.when("POST", () => {
          const resource = readResource(request);
          store.set(`${type}:${resource.id}`, {
            ...resource,
            attributes: resource.attributes ?? {},
          });
          return doc(store.get(`${type}:${resource.id}`));
        }),
        Match.when("PATCH", () => {
          const patch = readResource(request);
          const existing = store.get(`${type}:${id}`) ?? { type, id: defined(id), attributes: {} };
          const merged = {
            ...existing,
            attributes: { ...existing.attributes, ...patch.attributes },
          };
          store.set(`${type}:${id}`, merged);
          return doc(merged);
        }),
        Match.when("DELETE", () => {
          store.delete(`${type}:${id}`);
          return empty(204);
        }),
        Match.orElse(() => empty(405))
      );
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
    withLayer(
      JsonApiSync.layer(api, {
        baseUrl: "http://api.test",
        clientId: "c1",
        clientGroupId: "g1",
        ...Defined.fields({ includes: options?.includes }),
      }).pipe(Layer.provide(server.layer))
    ),
    Effect.scoped
  );

/** A row's string attribute; `None` when the attribute is absent or not a string. */
const attr = (value: JsonApiRow, key: string): Option.Option<string> =>
  Option.liftPredicate(value[key], P.isString);

const bodiesOf = (rows: ReadonlyArray<Relationships.RelatedRow>) =>
  decodeRows(defined(rows[0]).related.comments).map((c) => attr(c, "body"));

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
        const issue = defined(rows[0]);
        expect(attr(decodeRow(issue.related.author), "name")).toEqual(Option.some("Ada"));
        const comments = decodeRows(issue.related.comments);
        expect(comments.map((c) => attr(c, "body"))).toEqual([
          Option.some("first"),
          Option.some("second"),
        ]);
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
        const initial = defined((Option.isSome(first) ? first.value : [])[0]);
        expect(decodeRows(initial.related.comments).map((c) => attr(c, "body"))).toEqual([
          Option.some("first"),
          Option.some("second"),
        ]);

        // Editing a referenced comment is reflected in the resolved join.
        yield* engine.mutate("comments/update", {
          type: "comments",
          id: "c1",
          attributes: { body: "edited" },
        });
        yield* engine.push;
        yield* engine.pull;

        const rows = yield* Relationships.query(engine, issues, ["comments"]);
        expect(decodeRows(defined(rows[0]).related.comments).map((c) => attr(c, "body"))).toEqual([
          Option.some("edited"),
          Option.some("second"),
        ]);
      }),
      server
    );
  });

  // Real-clock test: a forked observer collects the join's emissions while a
  // referenced (not base) row is edited, proving the live join re-emits
  // incrementally without the base subset changing.
  it.live(
    "re-emits the join incrementally when a referenced row changes",
    () => {
      const server = makeServer(seed);
      return provide(
        Effect.gen(function* () {
          const engine = yield* ClientEngine.ClientEngine;
          yield* syncAll(engine);

          const seen = yield* SubscriptionRef.make<ReadonlyArray<ReadonlyArray<unknown>>>([]);
          // Wait on the observer's emissions, not on wall-clock time.
          const emitted = (until: (emissions: ReadonlyArray<ReadonlyArray<unknown>>) => boolean) =>
            SubscriptionRef.changes(seen).pipe(Stream.filter(until), Stream.runHead);
          yield* Effect.forkScoped(
            Stream.runForEach(Relationships.observe(engine, issues, ["comments"]), (rows) =>
              SubscriptionRef.update(seen, (acc) => [...acc, bodiesOf(rows)])
            )
          );
          yield* emitted((emissions) => Arr.isReadonlyArrayNonEmpty(emissions));

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
          expect(settled).toEqual([Option.some("edited"), Option.some("second")]);
          // ...and the observer re-emits it. Its emissions can lag the pull
          // (and a push ack briefly re-emits the pre-edit join), so wait
          // for the latest one to match rather than reading a snapshot.
          const latest = yield* emitted(
            (acc) => acc.length >= 2 && encodeJson(acc.at(-1)) === encodeJson(settled)
          );
          assert(Option.isSome(latest));
          const emissions = latest.value;
          expect(emissions[0]).toEqual([Option.some("first"), Option.some("second")]);
          expect(emissions[emissions.length - 1]).toEqual([
            Option.some("edited"),
            Option.some("second"),
          ]);
          expect(emissions.length).toBeGreaterThanOrEqual(2);
        }),
        server
      );
    },
    10000
  );

  it.effect("auto-subscribes the referenced collections (narrowed by id)", () => {
    const server = makeServer(seed);
    return provide(
      Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        // No manual subscribe of comments/people — related() does it.
        const stream = yield* Relationships.related(engine, issues, ["author", "comments"]);
        const head = yield* Stream.runHead(stream);
        const issue = defined((Option.isSome(head) ? head.value : [])[0]);

        expect(attr(decodeRow(issue.related.author), "name")).toEqual(Option.some("Ada"));
        expect(decodeRows(issue.related.comments).map((c) => attr(c, "body"))).toEqual([
          Option.some("first"),
          Option.some("second"),
        ]);
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
        const issue = defined((Option.isSome(head) ? head.value : [])[0]);

        expect(decodeRows(issue.related.comments).map((c) => attr(c, "body"))).toEqual([
          Option.some("first"),
          Option.some("second"),
        ]);
        expect(attr(decodeRow(issue.related.author), "name")).toEqual(Option.some("Ada"));

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
