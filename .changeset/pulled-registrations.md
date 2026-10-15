---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-browser": minor
---

A covered read is answered from the replica only once the windows it depends on have been pulled (#426). A window is pulled once a pull that started after it was subscribed has applied, or once another pulled window covers it. A relational registration's windows are marked one by one, so a new edge window does not reset the windows already pulled: a read needing only those keeps being covered while the new window waits for a pull. Before then, `Client.query` falls through to the server (offline, it answers locally, as it does for any uncovered read), and the JSON:API façade forwards the request online and answers `503` offline. This closes a window in which a covered first page could be served with the linkage of a relationship whose pin had not yet been pulled.

The pull state is recomputed, not persisted: after a restart each window starts unpulled until a pull lands. `ClientEngine` gains a read-only `pullCounts`; `ClientView` gains `pulled(key)`, which answers with a per-registration summary (`Coverage.Pulled`); the mirror protocol gains a host message, `PulledRegistrations`, which an older mirror ignores. A host now pulls promptly after a plain subscribe, as it already did for named queries.
