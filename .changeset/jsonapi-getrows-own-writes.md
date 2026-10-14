---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiBackend` keeps its row cache current with its own writes, so `getRows` no longer serves a row a push has updated or deleted at its pre-push value. After an applied create, update or delete, the cache holds the row's value after the write (the server's returned document when it sends one), or no row after a delete. Before this, a row a listing had cached was served from the cache until the next listing.
