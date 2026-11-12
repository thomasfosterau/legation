---
"@thomasfosterau/legation-browser": minor
---

`ElectedHost.run` returns a Client typed by the `nodes` it is given (#140): `ElectedHost.ElectedHost<Graph>` and `ElectedHostOptions<Graph>` carry the graph, so the tab's `client.query` / `client.observe` type their rows from it. Both type parameters default to an untyped graph.
