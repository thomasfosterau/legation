---
"@thomasfosterau/legation-jsonapi": minor
---

**`RestHandlers.make` resolves identity through the `IdentityResolver` (#645).** `RestHandlers.Options` is now `IdentityOptions | ContextOptions` over a shared `BaseOptions`:

- **`identity?: Authorization.IdentityResolver`** (with `clientGroupId?`, default `"http"`): the request's headers become its `Authorization.RequestCredentials` and the resolver is called with `{ clientGroupId, credentials }`, as every sync carrier calls it (ADR-0035). A failing resolver is a 403; without `identity` every request is anonymous.
- **`context`**, as before, for an identity the resolver cannot see. The two are mutually exclusive in the type.

**Breaking:** `Options` is a union type rather than an interface, so `RestHandlers.Options["context"]` is now optional; name `RestHandlers.ContextOptions["context"]` instead.
