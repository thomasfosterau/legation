/**
 * LiveView: incremental maintenance of a filtered + sorted + paginated result,
 * with the window boundary handled correctly (inserts push out, deletes pull
 * in, out-of-page changes don't disturb the visible page).
 */
import { describe, expect, it } from "vitest";
import * as LiveView from "../LiveView.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";

const row = (id: string, rank: number, open = true): LiveView.Row => ({
  id,
  value: { rank, open },
});
const ids = (rows: ReadonlyArray<LiveView.Row>) => rows.map((r) => r.id);

const ranked = Subset.make({ collection: "items", orderBy: [{ field: "rank", direction: "asc" }] });
const top2 = Subset.make({
  collection: "items",
  orderBy: [{ field: "rank", direction: "asc" }],
  limit: 2,
});

describe("LiveView", () => {
  it("filters and sorts the initial snapshot", () => {
    const onlyOpen = Subset.make({
      collection: "items",
      where: Predicate.eq("open", true),
      orderBy: [{ field: "rank", direction: "asc" }],
    });
    const view = LiveView.make(onlyOpen, [row("a", 3), row("b", 1, false), row("c", 2)]);
    expect(ids(LiveView.result(view))).toEqual(["c", "a"]); // b filtered out, sorted by rank
  });

  it("places an upsert at its sorted position", () => {
    let view = LiveView.make(ranked, [row("a", 1), row("c", 3)]);
    view = LiveView.put(view, row("b", 2));
    expect(ids(LiveView.result(view))).toEqual(["a", "b", "c"]);
    // Updating a row's sort key repositions it.
    view = LiveView.put(view, row("a", 4));
    expect(ids(LiveView.result(view))).toEqual(["b", "c", "a"]);
  });

  it("maintains the page across the limit boundary", () => {
    let view = LiveView.make(top2, [row("a", 1), row("c", 3)]);
    expect(ids(LiveView.result(view))).toEqual(["a", "c"]);

    // Insert into the page pushes the last visible row out.
    view = LiveView.put(view, row("b", 2));
    expect(ids(LiveView.result(view))).toEqual(["a", "b"]);

    // Delete from the page pulls the next row in from beyond the limit.
    view = LiveView.del(view, "a");
    expect(ids(LiveView.result(view))).toEqual(["b", "c"]);
  });

  it("ignores changes beyond the visible page (same window result)", () => {
    const view = LiveView.make(top2, [row("a", 1), row("b", 2), row("c", 3)]);
    const before = LiveView.result(view);
    const after = LiveView.result(LiveView.put(view, row("d", 4))); // sorts last, beyond limit 2
    expect(ids(before)).toEqual(["a", "b"]);
    expect(ids(after)).toEqual(["a", "b"]);
  });

  it("removes a row that no longer matches the predicate", () => {
    const open = Subset.make({
      collection: "items",
      where: Predicate.eq("open", true),
      orderBy: [{ field: "rank", direction: "asc" }],
    });
    let view = LiveView.make(open, [row("a", 1), row("b", 2)]);
    view = LiveView.put(view, row("a", 1, false)); // a is now closed
    expect(ids(LiveView.result(view))).toEqual(["b"]);
  });

  it("returns the same reference on a no-op", () => {
    const view = LiveView.make(ranked, [row("a", 1)]);
    expect(LiveView.del(view, "missing")).toBe(view);
  });

  it("windows by cursor", () => {
    const afterA = Subset.make({
      collection: "items",
      orderBy: [{ field: "rank", direction: "asc" }],
      cursor: "a",
    });
    const view = LiveView.make(afterA, [row("a", 1), row("b", 2), row("c", 3)]);
    expect(ids(LiveView.result(view))).toEqual(["b", "c"]);
  });
});
