---
"@legation/effect": minor
---

The Server facade (ADR-0022, program step 7): `Server.make({ backend,
auth, queries?, middleware?, cvr?, bus? })` builds the one server-side
object — the protocol handler (push/pull with CVR diffing, mount it on
any router or carrier) plus `server.broadcast({ collection, ids? })`, the
single verb for "these resources changed". Pushed mutations broadcast
implicitly through the push path's hints; `broadcast` covers out-of-band
writers (cron, admin tools, anything bypassing mutations — ADR-0019 in
one line). CVR storage and the fan-out bus default to in-memory /
in-process and swap for scale-out (ADR-0011) without app-code changes;
ADR-0023's topic-derived fan-out lands behind `broadcast` without
changing its signature. Additive.
