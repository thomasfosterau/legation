---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-browser": minor
---

A covered read is answered from the replica only once the windows its rows link to have been pulled (#426). A window is pulled once a pull that started after it was held has applied, or once an already-pulled window covers it. Each window is marked on its own, so a new edge window does not reset the windows already pulled. A read needs the edge windows its root rows link to, and an unpulled window of a sibling key does not uncover a read that links only to other keys. A relational registration whose root is pulled but whose edge windows are not yet held covers nothing. Before its windows are pulled, `Client.query` falls through to the server (offline, it answers locally, as for any uncovered read), and the JSON:API façade forwards the request online and answers `503` offline.

The pull state is recomputed, not persisted: after a restart each window starts unpulled until a pull lands. `ClientEngine` gains a read-only `pullCounts`; `ClientView.pulled(key)` answers with a per-window summary (`Coverage.Pulled`); `Coverage` gains `pulledFor` and `windowKey`; the mirror protocol gains a host message, `PulledRegistrations`, which an older mirror ignores (it is an addition, and replaces no message). A host now pulls promptly after a plain subscribe, as it already did for named queries.
