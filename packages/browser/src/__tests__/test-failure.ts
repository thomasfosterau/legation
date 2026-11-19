import * as Schema from "effect/Schema";

/** A deliberate failure, defect or rejection a test injects, tagged so it is never a bare `Error`. */
export class TestFailure extends Schema.TaggedError<
  TestFailure,
  { readonly brand: unique symbol }
>()("TestFailure", { message: Schema.String }) {}
