---
"@legation/effect": minor
"@legation/browser": minor
---

Connection-status realism at the transport seam: `Transport.withInferredStatus`
derives real connectivity from observed push/pull behaviour ("connecting"
until the first call settles, "connected" on success, "disconnected" on a
`TransportError`) — wrapping the default RPC carrier, which reports itself
permanently "connected". `Transport.withFallback(primary, fallback)` layers a
fallback carrier (e.g. plain HTTP under WebSockets) with a sideline cooldown
(`restoreAfter`, default 30s), merged pokes that survive a failing primary
poke stream, inferred status ("connected" while either carrier serves), and
version rejections propagating without falling back.
`BrowserConnectivity.withBrowserConnectivity` now combines `navigator.onLine`
with the wrapped transport's own status (worst of the two wins) instead of
replacing it.
