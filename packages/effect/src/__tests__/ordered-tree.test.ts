/**
 * OrderedTree: correctness of the persistent weight-balanced tree LiveView
 * maintains its order in (issue #112) — insert/remove/rank/slice against a
 * plain-array reference, plus the "same reference on no-op" contract.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as OrderedTree from "../OrderedTree.js";

const numberCompare = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

describe("OrderedTree", () => {
  it("builds from a sorted array and reads back in order", () => {
    const sorted = [1, 2, 3, 4, 5];
    const tree = OrderedTree.fromSorted(sorted);
    expect(OrderedTree.toArray(tree)).toEqual(sorted);
    expect(OrderedTree.size(tree)).toBe(5);
  });

  it("inserts maintain sorted order", () => {
    let tree: OrderedTree.Tree<number> = undefined;
    for (const value of [5, 3, 8, 1, 4, 7, 9, 2, 6]) {
      tree = OrderedTree.insert(tree, value, numberCompare);
    }
    expect(OrderedTree.toArray(tree)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(OrderedTree.size(tree)).toBe(9);
  });

  it("insert replaces an exact match rather than duplicating it", () => {
    let tree: OrderedTree.Tree<number> = OrderedTree.fromSorted([1, 2, 3]);
    tree = OrderedTree.insert(tree, 2, numberCompare);
    expect(OrderedTree.toArray(tree)).toEqual([1, 2, 3]);
    expect(OrderedTree.size(tree)).toBe(3);
  });

  it("removes a value, leaving the rest in order", () => {
    let tree: OrderedTree.Tree<number> = OrderedTree.fromSorted([1, 2, 3, 4, 5]);
    tree = OrderedTree.remove(tree, 3, numberCompare);
    expect(OrderedTree.toArray(tree)).toEqual([1, 2, 4, 5]);
    expect(OrderedTree.size(tree)).toBe(4);
  });

  it("remove of an absent value is a same-reference no-op", () => {
    const tree = OrderedTree.fromSorted([1, 2, 3]);
    expect(OrderedTree.remove(tree, 99, numberCompare)).toBe(tree);
  });

  it("rankOf finds the 0-based position, or -1 when absent", () => {
    const tree = OrderedTree.fromSorted([10, 20, 30, 40, 50]);
    expect(OrderedTree.rankOf(tree, 10, numberCompare)).toBe(0);
    expect(OrderedTree.rankOf(tree, 30, numberCompare)).toBe(2);
    expect(OrderedTree.rankOf(tree, 50, numberCompare)).toBe(4);
    expect(OrderedTree.rankOf(tree, 25, numberCompare)).toBe(-1);
  });

  it("at returns the value at a 0-based rank, or undefined out of bounds", () => {
    const tree = OrderedTree.fromSorted([10, 20, 30]);
    expect(OrderedTree.at(tree, 0)).toBe(10);
    expect(OrderedTree.at(tree, 2)).toBe(30);
    expect(OrderedTree.at(tree, 3)).toBeUndefined();
  });

  it("slice returns a bounded run starting at a rank", () => {
    const tree = OrderedTree.fromSorted([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(OrderedTree.slice(tree, 3, 4)).toEqual([3, 4, 5, 6]);
    expect(OrderedTree.slice(tree, 8, 5)).toEqual([8, 9]); // runs off the end
    expect(OrderedTree.slice(tree, 10, 5)).toEqual([]); // starts past the end
    expect(OrderedTree.slice(tree, 0, 0)).toEqual([]);
  });

  it("stays correct under randomized insert/remove churn against an array reference", () => {
    let tree: OrderedTree.Tree<number> = undefined;
    let reference: Array<number> = [];
    let state = 42;
    const next = () => {
      // xorshift32 — deterministic, no Math.random dependency.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0xffffffff;
    };
    for (let i = 0; i < 2000; i++) {
      if (reference.length === 0 || next() < 0.6) {
        const value = Math.floor(next() * 10_000);
        if (!reference.includes(value)) {
          tree = OrderedTree.insert(tree, value, numberCompare);
          reference.push(value);
          reference = Arr.sort(reference, Order.Number);
        }
      } else {
        const index = Math.floor(next() * reference.length);
        const value = reference[index]!;
        tree = OrderedTree.remove(tree, value, numberCompare);
        reference = reference.filter((v) => v !== value);
      }
      expect(OrderedTree.toArray(tree)).toEqual(reference);
      expect(OrderedTree.size(tree)).toBe(reference.length);
    }
  });
});
