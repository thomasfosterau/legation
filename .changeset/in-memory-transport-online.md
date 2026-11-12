---
"@thomasfosterau/legation": minor
---

**`Transport.makeInMemory`** gains per-call credentials and a failing offline mode (#649):

- **`InMemoryOptions.credentials`** also accepts an `Effect<Option<RequestCredentials>>`, evaluated on every push, pull and read, so a loopback client whose session changes (a cookie jar a sign-in or sign-out writes) presents the current session's credentials.
- **`setOnline(online)`** on the returned transport: offline, every push, pull and read fails with a `TransportError` and the status reads `"disconnected"`, until `setOnline(true)` (status `"connected"`). `setStatus` still changes only the reported status.
- The returned transport is typed as the new **`Transport.InMemoryTransport`** (a `ClientTransport` with `setStatus` and `setOnline`).
