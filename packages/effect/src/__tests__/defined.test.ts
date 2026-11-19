import { describe, expect, it } from "@effect/vitest";
import * as Defined from "../Defined.js";

interface Bag {
  readonly collection: string;
  readonly limit?: number;
  readonly cursor?: string;
}

describe("Defined.fields", () => {
  it("omits undefined members and keeps defined ones", () => {
    const limit = [1].find((n) => n > 5);
    const cursor = ["c1"].find((c) => c === "c1");
    const bag: Bag = { collection: "todos", ...Defined.fields({ limit, cursor }) };
    expect(bag).toStrictEqual({ collection: "todos", cursor: "c1" });
    expect("limit" in bag).toBe(false);
  });

  it("keeps falsy defined values", () => {
    const bag: Bag = { collection: "todos", ...Defined.fields({ limit: 0, cursor: "" }) };
    expect(bag).toStrictEqual({ collection: "todos", limit: 0, cursor: "" });
  });
});
