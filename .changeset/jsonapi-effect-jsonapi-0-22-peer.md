---
"@thomasfosterau/legation-jsonapi": minor
---

**Breaking:** `@thomasfosterau/effect-jsonapi` is now a **peer** (`^0.22.0`), no longer a regular dependency (`^0.21.0`), and the `effect` peer is raised to `^4.1.0` (was `^4.0.0`), because effect-jsonapi 0.22 peers `effect ^4.1.0`. The resources, documents and errors an app builds with effect-jsonapi are passed into this package, so there must be one copy of it: a regular dependency kept a second, 0.21 copy beside the app's own. Migration: install `@thomasfosterau/effect-jsonapi@^0.22.0` (and `effect@^4.1.0`) in the app, and migrate the app's own effect-jsonapi code with its 0.22.0 notes.

This package's own signatures are unchanged. What it takes from effect-jsonapi follows 0.22: `NodeBridge` reads a relationship descriptor's storage `key` and paginated `order` as the `Option`s effect-jsonapi 0.22 declares them (an undeclared key still defaults to `<name>Id`), and `RestHandlers`' 400 / 403 error documents read `ApiError`'s `Option` titles. The wire output is unchanged.
