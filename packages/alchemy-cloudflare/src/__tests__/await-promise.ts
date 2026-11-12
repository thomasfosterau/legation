import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A promise a test awaited rejected: the typed failure `awaitPromise` raises instead of a defect. */
export class PromiseRejected extends Schema.TaggedError<
  PromiseRejected,
  { readonly brand: unique symbol }
>()("PromiseRejected", {
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Await `thunk()` as an effect that fails with `PromiseRejected` when the promise rejects. */
export const awaitPromise = <A>(thunk: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: thunk, catch: (cause) => new PromiseRejected({ cause }) });
