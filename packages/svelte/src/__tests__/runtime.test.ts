/**
 * Runtime context rule: the stores read the engine runtime from Svelte
 * context, so using them without `setEngineRuntime` higher in the tree is a
 * setup error with an actionable message.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mount } from "svelte";
import NoRuntime from "./fixtures/NoRuntime.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("engine runtime context", () => {
  it("query() without setEngineRuntime throws an actionable error", () => {
    expect(() => mount(NoRuntime, { target: document.body })).toThrowError(/setEngineRuntime/);
  });
});
