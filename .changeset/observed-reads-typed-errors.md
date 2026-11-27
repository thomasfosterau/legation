---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-svelte": minor
"@thomasfosterau/legation-jsonapi": minor
---

Observed reads now carry the view's typed `ClientViewError` instead of dying with a defect. `Client.observe` and `Client.observeAnswers` (`ObserveOf`, `ObserveAnswersOf`), `Query.observe`, `Related.observe` / `observeWith`, `Related.related` / `relatedWith`, `ClientView.related` and the JSON:API `Relationships.observe` / `related` streams are now `Stream<…, ClientViewError>`. A registration the view refuses when an observed read starts, or a read of the view that fails while it runs (the root, or a foreign collection of a join), ends the stream with that error; the read's registration is released as before.

The Svelte read hooks (`useQuery`, `useAnswer`, `useConnection`, `useNamedQuery`, `useAggregate`, `useAggregateGrouped`) are now `Live<A, ReadError>` (`ReadError` is `ClientViewError`, exported from the package root): a failed read is an `AsyncResult.Failure` whose cause carries the error, and `promise` rejects with the error itself rather than a squashed defect.

**Migration.**

- Code that runs an observed read in an effect with an error channel of `never` now sees `ClientViewError`: handle it (`Stream.catch`, `Effect.catchTag`) or keep the old behaviour with `Stream.orDie`.
- A type annotated `Stream.Stream<ReadonlyArray<Related.RelatedRow>>` (or `Stream.Stream<Client.Answer>`) for one of these streams adds `ClientView.ClientViewError` as its error type.
- A custom `ClientView` implementation's `related` may now return a stream that fails with `ClientViewError`; one that never fails still satisfies the type.
- A Svelte annotation `Live<ResolvedRows<R>>` (or `Connection`'s rows) becomes `Live<ResolvedRows<R>, ReadError>`. A `failed` snippet or a `{:catch}` that inspected the squashed defect now receives the tagged error and can match on its `_tag`.
