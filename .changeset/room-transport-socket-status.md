---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

`RoomTransport`'s `status` and `statusChanges` now follow the poke socket instead of always reading `"connected"`, so a UI can show that live updates are degraded while the socket is down: `"connecting"` until the socket first opens (it dials when `pokes` is first subscribed) and while it re-dials, `"connected"` while it is open, and `"disconnected"` once a `reconnect` schedule ends. Push, pull and read never wait on the socket, so sync stays correct over HTTP alone. Each re-open emits `"connected"`, which starts the sync loop's push and pull, so pokes missed during an outage are caught up at once. A label that treated anything but `"connected"` as offline will now show the socket's outages; read `"disconnected"` as offline instead.
