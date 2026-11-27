---
"@thomasfosterau/legation": minor
---

`BackendContract`'s rule 11 parks its `contract/count-up` handler through a `ParkGates` service instead of a process-global gate map, so a backend whose handlers run outside the harness's process (a Worker, a remote room) can provide gates that reach the harness. The backend under test provides the service to its handlers, and `verifyBackendContract` opens its gates on the same instance: it now requires `ParkGates` (`Effect<void, ContractViolation, ParkGates>`). `layerParkGates` and `makeParkGates` are the in-memory implementation.

**Migration** (all on `@thomasfosterau/legation/internal`):

- `BackendContract.park(gate)` is gone. A `contract/count-up` handler takes the service when it is built and calls `gates.park(args.gate)` between its read and its write: `const gates = yield* BackendContract.ParkGates`.
- `BackendContract.memoryHandlers` is now `BackendContract.makeMemoryHandlers`, an effect that needs `ParkGates`: `MemoryBackend.make(yield* BackendContract.makeMemoryHandlers)`.
- Provide one `ParkGates` to both the backend's construction and `verifyBackendContract`, for example with `layer(BackendContract.layerParkGates)(...)` from `@effect/vitest`, or `Layer.provideMerge(BackendContract.layerParkGates)` under a backend layer.
