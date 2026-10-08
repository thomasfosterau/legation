---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiBackend` now fails the push when the pre-write read of an update or
delete does not return a row. A 4xx, a 404 included, fails the push the same way
a 5xx, timeout or transport error does: a `BackendError`, with nothing written on
the atomic path. A 2xx whose document names no resource fails it too. Before, a
refused read went ahead with no `oldValues` for that row. Every update or delete
now carries its old value or is not sent. A row the push creates is not read
unless the server refuses that create, so a 404 on it cannot fail an applied
create.

The cost is accepted: a row the server refuses to read stalls that client's
queue until the read can succeed or the client is reset. Deleting a row that is
already gone therefore fails with a 404 on every retry, where it used to be
acknowledged as a no-op. The failure reaches the client as a `TransportError`,
is retried by the client's retry policy, then surfaces as a `SyncFailure` with
`operation: "push"`. The in-session ledger belongs to one backend instance, so
after a restart an already-applied delete is sent again and stalls the same way.

On the atomic path, a create the server refuses, followed by an update or delete
of the same row in the same batch, now reads that row once the refusal arrives,
before the batch is resent, so the later write carries the row's pre-push value.
The read follows the same rule as any other: a failed read fails the push with
nothing written.

A resource that receives updates or deletes but has no `getOne` route now fails
any push containing one of those writes before any write in that push is sent,
instead of logging a warning and proceeding without `oldValues`.
