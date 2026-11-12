/**
 * `Derive.RowSchema` is a real row codec (#562): it checks a row's `id` and its relationship
 * linkage, and passes the flattened attributes through untouched, so the row `toRow` builds
 * round-trips and a row without an `id` or with malformed linkage is rejected.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Derive from "../Derive.js";

const decode = Schema.decodeUnknownExit(Derive.RowSchema);

describe("Derive.RowSchema", () => {
  it("decodes the row toRow builds, attributes included", () => {
    const row = Derive.toRow({
      type: "articles",
      id: "a-1",
      attributes: { title: "Hello", views: 3, tags: ["x"] },
      relationships: {
        author: { type: "people", id: "p-1" },
        comments: [{ type: "comments", id: "c-1" }],
        editor: null,
      },
    });
    expect(decode(row)).toEqual(Exit.succeed(row));
  });

  it("rejects a row without an id", () => {
    expect(Exit.isFailure(decode({ relationships: {}, title: "Hello" }))).toBe(true);
  });

  it("rejects malformed linkage", () => {
    expect(Exit.isFailure(decode({ id: "a-1", relationships: { author: "p-1" } }))).toBe(true);
  });
});
