---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

A room can use a per-request backend (#681): return `Backend.perRequest(acquire)` from `Room.make`'s `backend`, and the room builds the store in `acquire` once per push, pull and read, in that request's scope, so a Hyperdrive-backed `PgClient` is built from the current invocation's credentials and one push's transaction stays on its connection. The `backend` doc comment, the README and `docs/alchemy-postgres.md` (its Hyperdrive section, with an example over `Hyperdrive.ConnectClient`) say how.
