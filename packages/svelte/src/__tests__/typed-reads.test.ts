/**
 * Typed reads through the rune hooks (#140), in a program that registers no
 * graph: `useQuery` / `useAnswer` / `useConnection` accept any read, literal or dynamic,
 * and resolve it to the untyped row — never a compile error. (With a graph
 * registered, the examples' `svelte-check` runs are the typed half: their
 * pages read `row.value` and `row.related` with no cast.)
 *
 * The hooks need a component to run in, so the reads here are type-checked by
 * the `check` task and never run.
 */
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { Client, Query } from "@thomasfosterau/legation";
import {
  useAnswer,
  useConnection,
  useQuery,
  type Live,
  type ResolvedRows,
} from "../index.svelte.js";

const allTodos = { collection: "todos", include: { author: true } } as const satisfies Query.Read;

/** Compile-time assertions, never run (a hook outside a component throws). */
const compileOnly = (assertions: () => void): void => {
  expect(assertions).toBeTypeOf("function");
};

describe("typed reads, unregistered", () => {
  it("resolves a literal read to untyped rows when no graph is registered", () =>
    compileOnly(() => {
      const rows = useQuery(() => allTodos);
      expectTypeOf(rows).toEqualTypeOf<Live<ResolvedRows<typeof allTodos>>>();
      expectTypeOf<ResolvedRows<typeof allTodos>>().toEqualTypeOf<
        ReadonlyArray<Client.ResolvedRow>
      >();
    }));

  it("types useAnswer's rows as useQuery's, beside the completeness (#653)", () =>
    compileOnly(() => {
      const answer = useAnswer(() => allTodos);
      expectTypeOf(answer).toEqualTypeOf<Live<Client.Answer<typeof allTodos>>>();
      expectTypeOf<Client.Answer<typeof allTodos>["rows"]>().toEqualTypeOf<
        ResolvedRows<typeof allTodos>
      >();
      expectTypeOf<Client.Answer["completeness"]>().toEqualTypeOf<Client.Completeness>();
      const collection: string = "todos";
      void useAnswer(() => (collection === "" ? undefined : { collection }));
    }));

  it("accepts a dynamic read, an opted-out read and any collection", () =>
    compileOnly(() => {
      const collection: string = "todos";
      void useQuery(() => ({ collection }));
      void useQuery(() => (collection === "" ? undefined : allTodos));
      void useConnection(() => ({ collection: "anything", order: ["-whatever"] }), {
        pageSize: 10,
      });
    }));
});
