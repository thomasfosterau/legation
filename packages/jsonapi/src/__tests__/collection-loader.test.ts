/**
 * CollectionLoader tests: mapping JSON:API resources/documents into
 * collection rows, and loading them over a mocked HttpClient.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as CollectionLoader from "../CollectionLoader.js";

describe("resourceToRow", () => {
  it("maps attributes and relationship linkage", () => {
    const row = CollectionLoader.resourceToRow({
      type: "articles",
      id: "1",
      attributes: { title: "Hello" },
      relationships: {
        author: { data: { type: "people", id: "9" } },
        comments: {
          data: [
            { type: "comments", id: "5" },
            { type: "comments", id: "12" },
          ],
        },
        cover: { data: null },
        // No `data` member → omitted entirely.
        links: {},
      },
    });
    expect(row.collection).toBe("articles");
    expect(row.id).toBe("1");
    expect(row.value.attributes).toEqual({ title: "Hello" });
    expect(row.value.relationships).toEqual({
      author: { type: "people", id: "9" },
      comments: [
        { type: "comments", id: "5" },
        { type: "comments", id: "12" },
      ],
      cover: null,
    });
  });

  it("defaults missing attributes to an empty object", () => {
    const row = CollectionLoader.resourceToRow({ type: "tags", id: "t1" });
    expect(row.value).toEqual({ type: "tags", id: "t1", attributes: {}, relationships: {} });
  });
});

describe("documentToRows", () => {
  it("maps single, collection, and included data", () => {
    const single = CollectionLoader.documentToRows({
      data: { type: "users", id: "1", attributes: { name: "A" } },
      included: [{ type: "teams", id: "t", attributes: { name: "Core" } }],
    });
    expect(single.rows.map((r) => r.id)).toEqual(["1"]);
    expect(single.included.map((r) => r.collection)).toEqual(["teams"]);

    const collection = CollectionLoader.documentToRows({
      data: [
        { type: "users", id: "1" },
        { type: "users", id: "2" },
      ],
    });
    expect(collection.rows.map((r) => r.id)).toEqual(["1", "2"]);

    expect(CollectionLoader.documentToRows({ data: null }).rows).toEqual([]);
  });
});

describe("buildQueryString", () => {
  it("encodes include, sort, fields, filter, and page", () => {
    const query = CollectionLoader.buildQueryString({
      include: ["author"],
      sort: ["-createdAt"],
      fields: { articles: ["title", "body"] },
      filter: { status: "published" },
      page: { number: 2, size: 10 },
    });
    expect(query).toContain("include=author");
    expect(query).toContain("sort=-createdAt");
    expect(query).toContain("fields%5Barticles%5D=title%2Cbody");
    expect(query).toContain("filter%5Bstatus%5D=published");
    expect(query).toContain("page%5Bnumber%5D=2");
  });

  it("is empty without options", () => {
    expect(CollectionLoader.buildQueryString()).toBe("");
  });
});

const respondWith = (status: number, body: unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body === undefined ? null : JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/vnd.api+json" },
          })
        )
      )
    )
  );

const source = Layer.succeed(CollectionLoader.JsonApiSource)({ baseUrl: "https://api.test" });

describe("load / loadOne", () => {
  it.effect("loads a collection into rows", () =>
    Effect.gen(function* () {
      const loaded = yield* CollectionLoader.load("todos");
      expect(loaded.rows.map((r) => (r.value.attributes as { title: string }).title)).toEqual([
        "one",
        "two",
      ]);
    }).pipe(
      Effect.provide(
        respondWith(200, {
          data: [
            { type: "todos", id: "1", attributes: { title: "one" } },
            { type: "todos", id: "2", attributes: { title: "two" } },
          ],
        }).pipe(Layer.merge(source))
      )
    )
  );

  it.effect("loadOne returns the single row", () =>
    Effect.gen(function* () {
      const row = yield* CollectionLoader.loadOne("todos", "1");
      expect(row?.id).toBe("1");
    }).pipe(
      Effect.provide(
        respondWith(200, { data: { type: "todos", id: "1", attributes: {} } }).pipe(
          Layer.merge(source)
        )
      )
    )
  );

  it.effect("non-2xx responses become ApiError carrying the error objects", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(CollectionLoader.load("todos"));
      expect(failure._tag).toBe("ApiError");
      if (failure._tag === "ApiError") {
        expect(failure.errors[0]?.title).toBe("Forbidden");
      }
    }).pipe(
      Effect.provide(
        respondWith(403, { errors: [{ status: "403", title: "Forbidden" }] }).pipe(
          Layer.merge(source)
        )
      )
    )
  );

  it.effect("a document carrying errors becomes ApiError", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(CollectionLoader.load("todos"));
      expect(failure._tag).toBe("ApiError");
    }).pipe(
      Effect.provide(
        respondWith(200, { errors: [{ status: "422", title: "Unprocessable" }] }).pipe(
          Layer.merge(source)
        )
      )
    )
  );

  it.effect("a malformed document body becomes ParseError", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(CollectionLoader.load("todos"));
      expect(failure._tag).toBe("ParseError");
    }).pipe(Effect.provide(respondWith(200, { data: 42 }).pipe(Layer.merge(source))))
  );
});
