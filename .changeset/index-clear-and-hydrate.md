---
"@thomasfosterau/legation-effect": minor
---

Keep a secondary index in step with the confirmed-row writes that bypass a pull.

- `reset` (the identity `Reset`) now drops the built indexes along with the rows it clears. An indexed query after a reset could previously consult an index that still named the dropped rows.
- `Hydration.hydrate` into a store a running `ClientEngine` is built over now tells that engine to re-read: it drops its built indexes and its materialized view, and reveals the result. Before, an indexed query could return a row whose indexed field the hydrate had changed, while the row stayed present.
- A new `ClientEngine.clearRows` (on the `/internal` seam) drops every confirmed row, then the view and the built indexes with them. Use it on a running engine instead of `ClientStore.clearRows`, which left the engine showing the cleared rows.
- The re-read behind `hydrate` is `ClientEngine.resyncAttachedEngines` on the `/internal` seam. It is internal: app code calls `Hydration.hydrate`, not this.
