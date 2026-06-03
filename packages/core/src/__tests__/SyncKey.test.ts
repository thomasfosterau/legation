import { describe, expect, it } from "@effect/vitest";
import * as SyncKey from "../SyncKey.js";

describe("SyncKey", () => {
  it("hashes structurally-equal keys identically regardless of property order", () => {
    const a = SyncKey.hash(["users", { page: 1, filter: "active" }]);
    const b = SyncKey.hash(["users", { filter: "active", page: 1 }]);
    expect(a).toBe(b);
  });

  it("hashes different keys differently", () => {
    expect(SyncKey.hash(["users", "1"])).not.toBe(SyncKey.hash(["users", "2"]));
    expect(SyncKey.hash(["users", 1])).not.toBe(SyncKey.hash(["users", "1"]));
  });

  it("ignores undefined object properties", () => {
    const a = SyncKey.hash([{ page: 1, filter: undefined }]);
    const b = SyncKey.hash([{ page: 1 }]);
    expect(a).toBe(b);
  });

  it("compares keys structurally", () => {
    expect(SyncKey.equals(["users", "1"], ["users", "1"])).toBe(true);
    expect(SyncKey.equals(["users", "1"], ["users", "2"])).toBe(false);
    expect(SyncKey.equals(["users"], ["users", "1"])).toBe(false);
  });

  it("matches prefixes", () => {
    expect(SyncKey.startsWith(["users", "1", "posts"], ["users"])).toBe(true);
    expect(SyncKey.startsWith(["users", "1", "posts"], ["users", "1"])).toBe(true);
    expect(SyncKey.startsWith(["users", "1"], ["users", "1", "posts"])).toBe(false);
    expect(SyncKey.startsWith(["posts"], ["users"])).toBe(false);
    expect(SyncKey.startsWith(["users"], [])).toBe(true);
  });

  it("matches key filters", () => {
    expect(SyncKey.matches(["users", "1"], SyncKey.prefixFilter(["users"]))).toBe(true);
    expect(SyncKey.matches(["users", "1"], SyncKey.exactFilter(["users", "1"]))).toBe(true);
    expect(SyncKey.matches(["users", "1"], SyncKey.exactFilter(["users"]))).toBe(false);
    expect(
      SyncKey.matches(
        ["users", "1"],
        SyncKey.predicateFilter((key) => key.length === 2)
      )
    ).toBe(true);
  });
});
