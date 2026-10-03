---
"@thomasfosterau/legation-svelte": minor
"@thomasfosterau/legation-effect": patch
---

The rune hooks speak Query over the Client (ADR-0022 step 8). `useQuery`/`useAggregate`/`useAggregateGrouped` take declarative `Query.Read` thunks — `include`d edges resolve onto each row's `related` (windowed per the edge's declared order), so `useRelated` is removed; `useMutation`/`useMutationWithAck` run over the context Client. The hooks read a `ClientRuntime` (`ManagedRuntime<Client.Client>`) provided via `setClientRuntime`. `@thomasfosterau/legation-effect` adds the `Client` service tag and exposes `Client.nodes` (the registry the Client was built from).
