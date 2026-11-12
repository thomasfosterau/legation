---
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

`RoomTransport.make` now sends its push, pull and read requests through Effect's Fetch `HttpClient` instead of calling `fetch` directly. The request is unchanged: a JSON `POST` with your `headers`, and no `b3` or `traceparent` trace headers, so a cross-origin room needs no extra CORS allowance. Each answer is now decoded through the protocol's response schema, and an answer that doesn't match it fails with `TransportError`. Interrupting a request now aborts it. `make` still returns a `ClientTransport` with no requirements.
