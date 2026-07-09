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

  describe("no orderBy", () => {
    const unordered = Subset.make({ collection: "items" });

    it("falls back to id order as a total order (no ties)", () => {
      const view = LiveView.make(unordered, [row("c", 0), row("a", 0), row("b", 0)]);
      expect(ids(LiveView.result(view))).toEqual(["a", "b", "c"]);
    });

    it("locates and deletes a row without a full scan degrading to wrong results", () => {
      let view = LiveView.make(unordered, [row("a", 0), row("b", 0), row("c", 0), row("d", 0)]);
      view = LiveView.del(view, "b");
      expect(ids(LiveView.result(view))).toEqual(["a", "c", "d"]);
      view = LiveView.put(view, row("e", 0));
      expect(ids(LiveView.result(view))).toEqual(["a", "c", "d", "e"]);
    });
  });

  describe("positions", () => {
    it("assigns every in-window row a stable position key on the initial snapshot", () => {
      const view = LiveView.make(top2, [row("a", 1), row("b", 2), row("c", 3)]);
      const rows = LiveView.result(view);
      expect(rows.map((r) => r.position).every((p) => typeof p === "string" && p.length > 0)).toBe(
        true
      );
      // Positions sort the same way the rows are already sorted.
      expect(rows[0]!.position < rows[1]!.position).toBe(true);
    });

    it("keeps an unmoved row's position across an unrelated delta", () => {
      const view = LiveView.make(ranked, [row("a", 1), row("b", 2), row("c", 3)]);
      const before = LiveView.result(view).find((r) => r.id === "a")!.position;
      // Updating "c" (elsewhere in the order) doesn't touch "a"'s neighbors.
      const after = LiveView.put(view, row("c", 30));
      const afterPosition = LiveView.result(after).find((r) => r.id === "a")!.position;
      expect(afterPosition).toBe(before);
    });

    it("assigns a fresh position to a row entering the window and drops it on exit", () => {
      let view = LiveView.make(top2, [row("a", 1), row("c", 3)]);
      expect(LiveView.result(view).map((r) => r.id)).toEqual(["a", "c"]);

      // "b" enters the window, pushing "c" out.
      view = LiveView.put(view, row("b", 2));
      const rows = LiveView.result(view);
      expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
      expect(view.positions.has("c")).toBe(false); // left the window: no stale position kept
      expect(rows.every((r) => typeof r.position === "string")).toBe(true);
    });

    it("reassigns a moved row's position between its new neighbors", () => {
      let view = LiveView.make(ranked, [row("a", 1), row("b", 2), row("c", 3)]);
      const aBefore = LiveView.result(view).find((r) => r.id === "a")!.position;
      view = LiveView.put(view, row("a", 2.5)); // "a" moves between "b" and "c"
      const rows = LiveView.result(view);
      expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
      const aAfter = rows.find((r) => r.id === "a")!.position;
      const bPos = rows.find((r) => r.id === "b")!.position;
      const cPos = rows.find((r) => r.id === "c")!.position;
      expect(aAfter).not.toBe(aBefore);
      expect(bPos < aAfter && aAfter < cPos).toBe(true);
    });
  });

  describe("retarget", () => {
    it("widens the limit over the same maintained order (no re-materialization)", () => {
      const view = LiveView.make(ranked, [row("a", 1), row("b", 2), row("c", 3), row("d", 4)]);
      const first2 = LiveView.retarget(view, { limit: 2 });
      expect(ids(LiveView.result(first2))).toEqual(["a", "b"]);

      const first3 = LiveView.retarget(first2, { limit: 3 });
      expect(ids(LiveView.result(first3))).toEqual(["a", "b", "c"]);
      // Same underlying tree/index — retargeting never rebuilds them.
      expect(first3.order).toBe(view.order);
      expect(first3.byId).toBe(view.byId);
      // Rows that stayed in the window keep their positions.
      expect(first3.positions.get("a")).toBe(first2.positions.get("a"));
      expect(first3.positions.get("b")).toBe(first2.positions.get("b"));
    });

    it("advances via cursor over the same maintained order", () => {
      const view = LiveView.make(top2, [row("a", 1), row("b", 2), row("c", 3), row("d", 4)]);
      expect(ids(LiveView.result(view))).toEqual(["a", "b"]);
      const next = LiveView.retarget(view, { cursor: "b" });
      expect(ids(LiveView.result(next))).toEqual(["c", "d"]);
      expect(next.order).toBe(view.order);
    });

    it("is a same-reference no-op when neither limit nor cursor changes", () => {
      const view = LiveView.make(top2, [row("a", 1), row("b", 2)]);
      expect(LiveView.retarget(view, { limit: 2 })).toBe(view);
    });
  });
});
