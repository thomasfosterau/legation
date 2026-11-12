---
"@thomasfosterau/legation": minor
---

**`Authorization.namedSet(backend, { source, where, member, maxAge })`** (new, with **`Authorization.NamedSetOptions`**): a `NamedSet` whose members are read through the `Backend` (#647). Its members are the distinct scalar `member` values of the `source` rows `where(context)` selects; `where` returning `None` (an anonymous viewer) binds the empty set without a read, and a `BackendError` becomes an `AuthorizationError` naming `source`, which binds the set to nothing.
