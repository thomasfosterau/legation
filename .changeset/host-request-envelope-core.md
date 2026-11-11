---
"@thomasfosterau/legation": minor
---

The mirror protocol gains one generic host-request envelope (ADR-0021 amendment, #136), and introspection rides it, so a tab reads a service-worker-hosted engine through its `Mirror`.

- **Wire (additive):** `MirrorMessage` gains `HostRequest { mirrorId, requestId, kind, payload }` and `HostRequestCancel { mirrorId, requestId }`; `HostMessage` gains `HostResponse { mirrorId, requestId, outcome }`, the outcome a `Value`, an `Item`, an `End` or a `Failure` (`UnknownKind`, `InvalidRequest`, `Failed`). Nothing existing changes. A host that predates the envelope drops a request as foreign traffic; a mirror that predates it never sends one.
- **`HostRequest`** (new, `./internal`): declare a kind with `single` / `streaming` (name, request schema, response schema), serve it with `handler` / `streamHandler`, and fail as `HostRequestError` (`kind`, `reason`, `message`; reasons `UnknownKind`, `InvalidRequest`, `Failed`, `Unanswered`). `NoInput` and `Done` are the empty request and response.
- **`Mirror.request(kind, input)`** and **`Mirror.stream(kind, input)`**: typed single-reply and streaming requests. `MirrorOptions.requestTimeout` (default 10 seconds) fails an unanswered request with `Unanswered`; a host restart (`HostReady`) fails every request in flight the same way. A stream stopped or interrupted sends `HostRequestCancel`. Replies to another mirror are ignored.
- **`EngineHost.run`** gains `store` (serve the introspection kinds) and `requests` (serve your own handlers). It routes each request on a fiber of its own, keeps a per-mirror request table, and cancels a mirror's requests on its `Disconnect` or liveness sweep.
- **Introspection over a mirror:** `Introspection.requests` (the `introspect/subscriptions`, `introspect/journal`, `introspect/cookie`, `introspect/collections`, `introspect/syncFailures` and streaming `introspect/events` kinds), `Introspection.handlers(view)`, `Introspection.fromMirror(mirror)`, and the wire codecs `Introspection.EngineEvent` and `Introspection.SyncFailure`.
- `EngineIntrospection` takes an extra-error type parameter (`EngineIntrospection<E = never>`; `fromMirror`'s is `HostRequestError`) and gains `syncFailures`, the engine's recent terminal sync failures.
- `ClientEngine` gains `recentSyncFailures` (the last `ClientEngine.RECENT_SYNC_FAILURES`, 50, oldest first), a required member: a hand-written `ClientEngine` must add it.
