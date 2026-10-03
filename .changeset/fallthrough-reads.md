---
"@thomasfosterau/legation-effect": minor
---

Server-fallthrough reads (ADR-0025, ADR-0022 program step 6): a third protocol operation, `read` — a point-in-time batch subset evaluation under the same deny-by-default auth filters as pull, with no CVR involvement. `Client.query` now answers from the replica when the read's root window is in the Client's ledger and falls through to the server otherwise (degrading back to the local answer when the transport offers no `read` or the server is unreachable); results never enter the replica. Includes resolve through the fallthrough in at most two round trips with the same plan and windows as local reads. The hosted tier forwards reads over the mirror protocol (`Read`/`ReadResult`). `ServerHandler.handleRead` is required; `ClientTransport.read` and the new `SyncMiddleware.onRead` hook are optional.
