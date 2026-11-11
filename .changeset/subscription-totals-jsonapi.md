---
"@thomasfosterau/legation-jsonapi": minor
---

A collection document now carries `meta: { total }`, from the derived REST handler and the façade alike (#210, ADR-0029's #210 amendment). The total is how many rows the read's filter matches, whatever its page.

- `RestHandlers.list` writes `meta.total` for every listing.
- The façade writes it on every collection document it serves:
  - Under an unwindowed subscription, it counts the replica.
  - Under a windowed subscription, it uses that subscription's pulled total from the new `totalOf` option (`host.engine.totalOf` in a worker, `client.totalOf` over a Client).
  - **Behaviour change:** a read only a windowed subscription covers, with no known total, is now treated as uncovered: forwarded online, the `503` document offline. Before, it was served without a count. Pass `totalOf` to keep such listings served from the replica.
- `JsonApiBackend` provides `evaluateCounted`: the rows a listing returns, or the upstream listing's own non-negative integer `meta.total` when it sends one.
- `DocumentWriter.Input.meta` and the new `DocumentWriter.CollectionMeta` type are the `meta` channel. `CollectionDocument` now types an optional `meta`. `ReplicaDocuments.collection` and `fromUrl` take an optional `meta` argument.
