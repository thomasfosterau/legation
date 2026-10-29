---
"@thomasfosterau/legation-jsonapi": minor
---

`FacadeWrites.writesOf(nodes, options?)` is the inverse of `graphIntentOf` (ADR-0030 §5, #529): for every graph-derived CRUD mutation (`CrudMutation`, filtered by `writes` as the registry is) it says how the args replay as one JSON:API write, with each `one` edge's `via` key moved out of the attributes into `relationships[edge].data` (`null` linkage when the key is `null`). Pass it as a `JsonApiBackend`'s `writes`, so a node-graph app's journaled `{type}/create`, `{type}/update` and `{type}/delete` reach the server as the `POST`, `PATCH` and `DELETE` the app would have sent.

The write's `type` is always the mutation's own: args naming another type are refused (`FacadeWrites.InvalidWriteArgs`), and `JsonApiBackend` now reports any `writes` function that throws as invalid args, a `BackendError`, rather than a defect.
