---
"@thomasfosterau/legation-jsonapi": minor
---

**Breaking:** a `JsonApiBackend` `writes` function now returns `Result<Write, InvalidWriteArgs>` (the new `JsonApiBackend.Expression` type) instead of a `Write`, so a refusal is typed end to end. The backend still reports a failure as invalid args (a `BackendError`, as for args that do not decode); a function that throws is now a defect rather than a failure. `FacadeWrites.writesOf` returns its refusals (args naming another type, or args that are not the derived mutation's shape) as `InvalidWriteArgs` failures instead of throwing them. `InvalidWriteArgs` gains an optional `cause` and is now also exported from the package root; `FacadeWrites.InvalidWriteArgs` is the same class.

Migration: wrap what each `writes` function returns in `Result.succeed(...)`, and replace each `throw` of a refusal with `return Result.fail(new InvalidWriteArgs({ message }))`. Type the map as `Map<string, JsonApiBackend.Expression>`. A caller of a `FacadeWrites.writesOf` function reads its `Result` (for example `Result.getOrThrow`, or `Effect.fromResult` in an effect) instead of catching.
