---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-alchemy-cloudflare": minor
"@thomasfosterau/legation-svelte": minor
---

Mutation ids, client group ids and row ids are now branded types, so the compiler rejects one where another is expected: `MutationId` (a branded `number`), `ClientGroupId` and `RowId` (branded `string`s). They are defined in `Protocol` (`@thomasfosterau/legation/internal`) and re-exported where apps use them: `Client.ClientGroupId`, `Client.MutationId`, `Backend.ClientGroupId`, `Backend.MutationId` and `Collection.RowId`. A node's `Node.Id` is now a `RowId` too, so every node id works wherever a row id does.

The brands are compile-time only: the wire format, the stored formats and the runtime values don't change, and no migration of data is needed.

**Migration.** Each brand's schema has a `make` constructor for literals and values you mint yourself:

- `Client.make`, `ClientEngine.make` / `layer`, `Transport.makeInMemory`, `RpcTransport`, `ElectedHost.run`, `JsonApiSync.layer` and `Hydration` snapshots take a `ClientGroupId`: replace `clientGroupId: "g1"` with `clientGroupId: Client.ClientGroupId.make("g1")`. SvelteKit's `clientGroupId(cookies)` already returns one.
- A `Backend.SyncContext` (from an identity resolver, a `RestHandlers` `context`, or a direct `backend.applyMutations` call) carries a `ClientGroupId`: use `Backend.ClientGroupId.make(...)`.
- A `Protocol.Mutation` built by hand (seeding a backend with `applyMutations`, `Server.mutate`) needs `mutationId: Client.MutationId.make(n)`. `lastMutationIds` maps are `Record<string, MutationId>`.
- Row ids read from the engine (`row.id` from a query, patches, CVRs, `ChangeHint.ids`, `SeedRow.id`, `Backend.getRows`) are `RowId`. A backend or handler that returns `ChangeHint`s builds their ids with `Collection.RowId.make(id)`; a row id mapped from your own data (a JSON:API resource id, a SQL column) needs the same.
- Write inputs still take plain strings: `LocalWriter` and `BackendWriter` (`put` / `del` / `get`) and `Server.broadcast`'s `ids` accept a `string` id, so handlers that mint ids from their args don't change.
- Code generic over a schema's codec, such as `Schema.Codec<A>`, should take the encoded type too (`Schema.Codec<A, I>`) so a branded type isn't widened back to its unbranded encoding.
