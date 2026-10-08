---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiBackend` now fails the push when the pre-write read of an update or
delete is refused. A 4xx, a 404 included, fails the push the same way a 5xx,
timeout or transport error does: a `BackendError`, with nothing written on the
atomic path. Before, a refused read went ahead with no `oldValues` for that row.
Every update or delete now carries its old value or is not sent. A row the push
creates is still not read, so a 404 on it cannot fail the push. The cost is
accepted: a row the server refuses to read stalls that client's queue until the
refusal is resolved.

A resource that receives updates or deletes but has no `getOne` route now fails
each of those pushes, before anything is written, instead of logging a warning
and proceeding without `oldValues`.
