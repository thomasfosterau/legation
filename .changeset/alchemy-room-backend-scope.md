---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

`Room.make`'s `backend` and `hints` run with the room instance's `Scope` (#679), so a backend can hold a resource for the instance's life, such as a PostgreSQL pool built with `Layer.build(PgClient.layer(...))`. The README and the `backend` doc comment say what that lifetime is against hibernation and eviction, and that a Hyperdrive client must not be held across requests (#506).
