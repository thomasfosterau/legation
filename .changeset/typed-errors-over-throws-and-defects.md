---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

Failures that a caller can act on are now typed errors or `Result`s instead of throws and defects, and background work reports how it stopped.

**Sync loop.** `ClientEngine.runSync` is now `Effect<void, never, Scope>`: it never failed (each leg retries and then surfaces its failures on `syncFailures`), and its type now says so. A leg that dies (a defect in a transport stream, for example) is logged at `Error` with its cause and handed to any installed `ErrorReporter` (`Effect.withErrorReporting`), where before it stopped without a trace. `Client.make` and `JsonApiSync.start` no longer wrap the loop in `Effect.orDie`. Migration: drop any `Effect.orDie`, `Effect.ignore` or `catchTag` you applied to `runSync`; a `catchTag` on it no longer type-checks.

**One-shot reads fail with the view's error.** `Query.run`, `Query.runRows`, `Related.query`, `Related.queryRows`, `Related.queryWith`, `Related.resolveExistsLocally` and `legation-jsonapi`'s `Relationships.query` now fail with `ClientViewError` when the view cannot be read (a store error, or a mirror that lost its host), where they died before. `Client.query` and `Client.answer` already declared that error and now fail with it. Migration: handle (or `Effect.orDie`) the new error channel where you call these directly.

**Live joins end instead of hanging.** A `Related.observe` join (and every observed read with `include`) whose base or foreign observer dies now ends with that defect; before, the join stopped emitting and never ended. The auto-subscribing relational read (`Related.related`, `Related.trackEdges`) logs a failed read of its base rows and reconciles again on the next change, rather than dying.

**Reads are compiled when the effect runs.** `Client.query`, `Client.answer`, `Client.observe`, `Client.observeAnswers`, `Client.coverageOf`, `Query.run`, `Query.runRows` and `Query.observe` compile the read when the effect or stream runs, so an unknown collection or edge (a read that bypassed `Query.Validate`) is a defect of the effect, not an exception thrown at the call. `Query.planResult` is new: the `Result` that `Query.plan` throws from and `Query.tryPlan` fails with.

**`FractionalIndex` (`/internal`).** `generateBetween` and `generateNBetween` return `Result<…, InvalidBounds>` instead of throwing, and `InvalidBounds` is exported. `generateNBetween` now checks its bounds even for a count of 0. Migration: unwrap with `Result.match` (or `Result.getOrThrowWith(result, identity)` where your bounds are ordered by construction).

**`FilterCorpus` (`/internal`).** `resolveSeed` returns `Result<number, InvalidCorpusInput>`; `generateRows` and `generateCorpus` fail with `InvalidCorpusInput` for a row count below `minimumRows`, where they threw (a defect) before. `InvalidCorpusInput` is exported. Migration: `Result.getOrThrowWith(FilterCorpus.resolveSeed(env), identity)` at a test's module top level, and handle or `orDie` the new error channel.

**`legation-jsonapi` URL encoding.** `JsonApiQuery.canonical`, `toRequestOptions`, `buildQueryString` and `flatFilter` keep their signatures and still throw a `QueryError` for input they refuse; internally each is now a `Result`, so `urlReads(…).canonical` and the `defaultEncoder` fail with that `QueryError` directly. A filter tree that the flat codec cannot encode is now a `QueryError` from `flatFilter` and `buildQueryString`, where it was a `SchemaError`.

**`legation-alchemy-cloudflare`.** `BindingTransport` reads a failed call's error body without throwing inside its promise; the `TransportError` it fails with is unchanged.
