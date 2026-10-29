---
"@thomasfosterau/legation-effect": patch
---

A mirror's `mutate`, `mutateWithAck` and server-fallthrough `read` now get their own answer when another tab on the same host has a request of the same number in flight. `Mutate` and `Read` carry the mirror's id, and the host echoes it on `MutateAck`, `MutateError`, `MutateSettled` and `ReadResult`; a mirror ignores a reply addressed to another. The field is optional both ways, so a mirror and a host from before this change still work together, as they did before.
