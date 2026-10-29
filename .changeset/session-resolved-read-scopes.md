---
"@thomasfosterau/legation-effect": minor
---

Breaking: an auth filter now returns a `ReadScope` (ADR-0015's #205 amendment). The three outcomes are `Authorization.AllowAll`, `Authorization.Deny` and `Authorization.filter(predicate, sets)`. A bare `Predicate` is still accepted and means a filter with no named sets. `Authorization.allowAll` now returns `AllowAll` rather than an always-true predicate. Code that calls an `AuthFilter` itself must handle the wider return type (`Authorization.scopeOf` normalises it).

New: named, session-resolved sets. A predicate refers to one by name with `Predicate.inSet(field, name)`. The set is declared as an `Authorization.NamedSet` with a `source` collection, a `resolve` function and a `maxAge`. The sync server binds each set per session and caches it. A write to the set's source marks it stale and pokes the session, and a set older than its `maxAge` is resolved again on the next pull. Each per-session cookie carries a scope epoch, a hash of the bound sets, so a session whose set changed resets on its next pull. A set that cannot be resolved binds to nothing: it narrows, and never widens. An undeclared collection stays denied.
