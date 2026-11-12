---
"@thomasfosterau/legation-jsonapi": minor
---

**Breaking:** every public return and result field that may be absent is an `Option` (#562). Option bags lose `| undefined`: each optional member is `readonly x?: T`, so a caller holding `undefined` omits the key instead of passing it. Optional function parameters and the wire shapes (JSON:API documents, `meta`, `links`, the `data: null` empty to-one, the mutation status document) are unchanged, and so is behaviour.

Migrate each signature (old → new):

- **`CollectionLoader.loadOne(type, id, options?)`**: `Effect<CollectionRow | undefined, …>` → `Effect<Option<CollectionRow>, …>`.
- **`Convention.ResourceEndpoints`**: `list`, `getOne`, `create`, `update`, `delete`: `?: EndpointRef` → `Option<EndpointRef>` (required; `None` for a role the api does not serve). **`Convention.classify(method, path)`**: `{ type, operation } | undefined` → `Option<{ type, operation }>`. **`Convention.reflectAtomic(api)`**: `EndpointRef | undefined` → `Option<EndpointRef>`.
- **`JsonApiSync.inspect(api)`**: `{ atomic?: EndpointRef }` → `{ atomic: Option<EndpointRef> }`.
- **`JsonApiQuery.ParsedRead`** (`parseRead`, `parseParams`): `fields?: Projection` → `fields: Option<Projection>`; `id?: string` → `id: Option<string>` (`Some` for a `/{type}/{id}` path).
- **`JsonApiFacade.FetchHandler.handle(request)`**: `Effect<Response | undefined>` → `Effect<Option<Response>>` (`None`: not the façade's to answer; forward it).
- **`JsonApiFacade.Options.cookie`**: `Effect<string | undefined, unknown>` → `Effect<Option<string>, unknown>` (lift a store's cookie with `Effect.map(store.getCookie, Option.fromUndefinedOr)`). **`JsonApiFacade.Options.totalOf`**: `((subset) => Effect<number | undefined>) | undefined` → `(subset) => Effect<Option<number>>`.
- **`FacadeWrites.IntentOf`** and **`FacadeWrites.graphIntentOf(nodes)`**: `(write) => Intent | undefined` → `(write) => Option<Intent>` (so `JsonApiFacade.Options.intentOf` returns an `Option`). **`FacadeWrites.Preferences.wait`**: `?: number` → `Option<number>`. **`FacadeWrites.Refusal.pointer`**: `?: string` → `string` (every refusal names its member).
- **`Relationships.Lookup`**: `(collection, id) => JsonApiRow | undefined` → `(collection, id) => Option<JsonApiRow>`.
- **`JsonApiSync.JsonApiSyncOptions.pullInterval`**: `?: Duration.Input | null | undefined` → `?: Option<Duration.Input>`: absent keeps the 5-second default, `Option.some(interval)` sets it, and `Option.none()` disables interval pulling (was `null`).
- `| undefined` dropped from option-bag members (omit the key instead of passing `undefined`): **`JsonApiSync.JsonApiSyncOptions`** `queryEncoder`, `includes`, `ledger`, `keyValueStore`, `atomic`, `pushDebounce`, `store`; **`JsonApiBackend.JsonApiBackendConfig`** `writes`, `atomic`, `query`, `includes`, `ledger`; **`Ledger.keyValue`**'s `prefix`; **`DocumentWriter.Input`** `meta`; **`JsonApiFacade.Options`** `totalOf`.

Kept as they are, on purpose: `CollectionLoader.RelationshipRef`'s `null` (a stored and synced row value: JSON:API's empty to-one), `DocumentWriter.RelationshipValue` and `DataDocument`'s `data: null` (the wire document), and `Relationships.RelatedValue` (the core `Related.Strategy` shape the join compares).
