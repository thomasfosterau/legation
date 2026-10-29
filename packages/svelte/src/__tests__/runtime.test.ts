/**
 * Runtime context rule: the rune hooks read the Client runtime from Svelte
 * context, so using one without `setClientRuntime` higher in the tree is a
 * setup error with an actionable message.
 */
import { describe, expect, it, afterEach } from "vite-plus/test";
import { mount } from "svelte";
import NoRuntime from "./fixtures/NoRuntime.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("client runtime context", () => {
  it("a hook without setClient throws an actionable error", () => {
    expect(() => mount(NoRuntime, { target: document.body })).toThrowError(
      /setClient\(createClient/
    );
  });
});
