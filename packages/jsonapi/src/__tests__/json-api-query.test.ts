/**
 * JsonApiQuery tests: the Subset → JSON:API query encoder (sound-superset
 * default), and that server-side `filter` narrowing actually reaches the API.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Predicate } from "@legation/effect";
import { ClientEngine, Subset } from "@legation/effect/internal";
import * as JsonApiQuery from "../JsonApiQuery.js";
import * as JsonApiSync from "../JsonApiSync.js";

describe("JsonApiQuery.defaultEncoder", () => {
  it("encodes eq/in conjuncts and sort", () => {
    const query = JsonApiQuery.defaultEncoder.encode(
      Subset.make({
        collection: "todos",
        where: Predicate.and(Predicate.eq("status", "open"), Predicate.isIn("priority", [1, 2])),
        orderBy: [{ field: "created", direction: "desc" }],
      })
    );
    expect(query).toContain("filter%5Bstatus%5D=open");
    expect(query).toContain("filter%5Bpriority%5D=1%2C2");
    expect(query).toContain("sort=-created");
  });

  it("drops what it can't soundly express (operators, or/not, eq null)", () => {
    expect(
      JsonApiQuery.toRequestOptions(
        Subset.make({ collection: "t", where: Predicate.gt("age", 18) })
      )
    ).toEqual({});
    expect(
      JsonApiQuery.toRequestOptions(
        Subset.make({
          collection: "t",
          where: Predicate.or(Predicate.eq("a", 1), Predicate.eq("b", 2)),
        })
      )
    ).toEqual({});
    expect(
      JsonApiQuery.toRequestOptions(
        Subset.make({ collection: "t", where: Predicate.not(Predicate.eq("a", 1)) })
      )
    ).toEqual({});
    // A conjunct it understands survives even alongside ones it doesn't.
    expect(
      JsonApiQuery.toRequestOptions(
        Subset.make({
          collection: "t",
          where: Predicate.and(Predicate.eq("status", "open"), Predicate.gt("age", 18)),
        })
      )
    ).toEqual({ filter: { status: "open" } });
  });
});

const idParam = { params: Schema.Struct({ id: Schema.String }) };
const body = { payload: Schema.Unknown, success: Schema.Unknown };
const api = HttpApi.make("app").add(
  HttpApiGroup.make("todos")
    .add(HttpApiEndpoint.get("list", "/todos", { success: Schema.Unknown }))
    .add(HttpApiEndpoint.post("create", "/todos", body))
    .add(HttpApiEndpoint.patch("update", "/todos/:id", { ...idParam, ...body }))
    .add(HttpApiEndpoint.make("DELETE")("remove", "/todos/:id", idParam))
);

interface Stored {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

/** Server that honours `filter[field]` equality/membership and records URLs. */
const makeServer = (seed: ReadonlyArray<Stored>) => {
  const store = new Map(seed.map((r) => [r.id, r]));
  const requests: Array<string> = [];
  const headers = { "Content-Type": "application/vnd.api+json" };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.pathname + url.search);
      let rows = [...store.values()];
      for (const [key, value] of url.searchParams) {
        const match = key.match(/^filter\[(.+)\]$/);
        if (match === null) continue;
        const field = match[1]!;
        const allowed = value.split(",");
        rows = rows.filter((row) => allowed.includes(String(row.attributes[field])));
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ data: rows }), { status: 200, headers })
      );
    })
  );
  return { store, requests, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

describe("server-side narrowing", () => {
  it.effect("pushes filter to the API and narrows the listing", () => {
    const server = makeServer([
      { type: "todos", id: "1", attributes: { status: "open" } },
      { type: "todos", id: "2", attributes: { status: "done" } },
    ]);
    const open = Subset.make({ collection: "todos", where: Predicate.eq("status", "open") });

    return Effect.gen(function* () {
      const engine = yield* ClientEngine.ClientEngine;
      yield* engine.subscribe(open);
      yield* engine.pull;

      const rows = yield* engine.query(open);
      expect(rows.map((r) => r.id)).toEqual(["1"]);
      // The narrowing reached the server, not just the local Subset.apply.
      expect(server.requests.some((url) => url.includes("filter%5Bstatus%5D=open"))).toBe(true);
    }).pipe(
      Effect.provide(
        JsonApiSync.layer(api, {
          baseUrl: "http://api.test",
          clientId: "c1",
          clientGroupId: "g1",
        }).pipe(Layer.provide(server.layer))
      ),
      Effect.scoped
    );
  });
});
