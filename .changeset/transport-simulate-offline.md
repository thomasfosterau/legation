---
"@legation/effect": minor
---

Add `Transport.simulateOffline`: a decorator wrapping any `ClientTransport`
with a toggleable offline gate (push/pull/read fail with a `TransportError`
while toggled offline, mirroring a real network drop, so the engine keeps
mutations in the journal and its sync loop flushes them on reconnect).
Generalises the offline-gate transport the demo examples each hand-rolled
into reusable substrate — it now
backs both examples' offline toggle, and `@legation/devtools`' actions panel
(#120) offline-toggle action.
