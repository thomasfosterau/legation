import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Cvr from "../Cvr.js";
import * as Predicate from "../Predicate.js";
import * as Protocol from "../Protocol.js";
import * as Subset from "../Subset.js";

describe("Predicate", () => {
  const row = { id: "1", status: "open", priority: 3 };

  it("evaluates comparisons, membership, and boolean composition", () => {
    expect(Predicate.test(Predicate.always, row)).toBe(true);
    expect(Predicate.test(Predicate.eq("status", "open"), row)).toBe(true);
    expect(Predicate.test(Predicate.ne("status", "open"), row)).toBe(false);
    expect(Predicate.test(Predicate.gt("priority", 2), row)).toBe(true);
    expect(Predicate.test(Predicate.lte("priority", 2), row)).toBe(false);
    expect(Predicate.test(Predicate.isIn("status", ["open", "closed"]), row)).toBe(true);
    expect(
      Predicate.test(
        Predicate.and(Predicate.eq("status", "open"), Predicate.gt("priority", 5)),
        row
      )
    ).toBe(false);
    expect(
      Predicate.test(
        Predicate.or(Predicate.eq("status", "closed"), Predicate.gt("priority", 1)),
        row
      )
    ).toBe(true);
    expect(Predicate.test(Predicate.not(Predicate.eq("status", "open")), row)).toBe(false);
  });

  it("mismatched comparison types never match", () => {
    expect(Predicate.test(Predicate.gt("status", 1), row)).toBe(false);
  });

  it.effect("round-trips through its schema", () =>
    Effect.gen(function* () {
      const predicate = Predicate.and(
        Predicate.eq("status", "open"),
        Predicate.not(Predicate.isIn("priority", [1, 2]))
      );
      const encoded = yield* Schema.encodeEffect(Predicate.PredicateSchema)(predicate);
      const decoded = yield* Schema.decodeUnknownEffect(Predicate.PredicateSchema)(
        JSON.parse(JSON.stringify(encoded))
      );
      expect(decoded).toEqual(predicate);
    })
  );
});

describe("Subset.apply", () => {
  const rows = [
    { id: "a", value: { name: "alpha", rank: 2 } },
    { id: "b", value: { name: "beta", rank: 1 } },
    { id: "c", value: { name: "gamma", rank: 3 } },
  ];

  it("filters, orders, and limits", () => {
    const subset = Subset.make({
      collection: "items",
      where: Predicate.gt("rank", 0),
      orderBy: [{ field: "rank", direction: "desc" }],
      limit: 2,
    });
    expect(Subset.apply(rows, subset).map((r) => r.id)).toEqual(["c", "a"]);
  });

  it("applies the cursor as 'strictly after this row id'", () => {
    const subset = Subset.make({
      collection: "items",
      orderBy: [{ field: "rank", direction: "asc" }],
      cursor: "b",
      limit: 1,
    });
    expect(Subset.apply(rows, subset).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("Cvr.diff", () => {
  it("puts missing and stale rows, deletes departed rows", () => {
    const previous: Cvr.Cvr = {
      rows: new Map([
        [
          "todos",
          new Map([
            ["1", 1],
            ["2", 1],
          ]),
        ],
      ]),
    };
    const next: Cvr.NextView = {
      rows: new Map([
        [
          "todos",
          new Map([
            ["1", 2],
            ["3", 1],
          ]),
        ],
      ]),
    };
    const result = Cvr.diff(previous, next);
    expect(result.puts).toEqual([
      { collection: "todos", id: "1" },
      { collection: "todos", id: "3" },
    ]);
    expect(result.dels).toEqual([{ collection: "todos", id: "2" }]);
  });

  it("is empty for identical views", () => {
    const view = { rows: new Map([["todos", new Map([["1", 1]])]]) };
    const result = Cvr.diff(view, view);
    expect(result.puts).toEqual([]);
    expect(result.dels).toEqual([]);
  });
});

describe("Protocol schemas", () => {
  it.effect("round-trips a pull response", () =>
    Effect.gen(function* () {
      const response: Protocol.PullResponse = {
        cookie: "cvr-1",
        patch: [
          { _tag: "Clear" },
          { _tag: "Put", collection: "todos", id: "1", version: 2, value: { title: "hi" } },
          { _tag: "Del", collection: "todos", id: "2" },
        ],
        lastMutationIds: { "client-a": 4 },
      };
      const encoded = yield* Schema.encodeEffect(Protocol.PullResponseSchema)(response);
      const decoded = yield* Protocol.decodePullResponse(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(response);
    })
  );

  it.effect("rejects malformed messages with ProtocolError", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Protocol.decodePushRequest({ nope: true }));
      expect(result._tag).toBe("Failure");
    })
  );
});
