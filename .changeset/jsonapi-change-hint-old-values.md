---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiBackend` change hints now carry `oldValues`: each row an update or
delete touches is hinted with its value before the push, as `MemoryBackend`
does, so topic-derived fan-out (ADR-0023) pokes the windows a row moved away
from. A REST API keeps no change token, so the old value is read: each update
or delete makes one `GET /{type}/{id}` before its write, once per row per push,
on both the per-resource and the atomic path. That is one extra request per
update and delete. A row the push creates has no old value. A read that fails
transiently fails the push. On the atomic path nothing has been written by then,
so the retry reads again. On the per-resource path the writes before the failed
read have already applied, so their hints are lost, as with any transient write
failure there. A read that finds no row (404) or is refused with another 4xx
leaves that row with no `oldValues` entry, and logs a warning.

A create or update's hinted value is now the server's returned document whenever
it sends one (the per-resource path used to ignore it), else the row read before
the push merged with the write, so a partial PATCH hints the full row.

Fix: a hinted create or update's relationships were the request's raw JSON:API
`{ data }` form. They now use the linkage shape `toRow` gives a server document
(`{ type, id }`, an array, or `null`), the shape listings and stored rows use, so
a hint matches the row it describes.
