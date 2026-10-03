---
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-effect": patch
---

Built-in multi-tab leader election for the no-service-worker degraded
topology (#119): `@thomasfosterau/legation-browser`'s `ElectedHost.run` wraps
`navigator.locks` (held for the tab's whole lifetime, no voluntary
step-down) around `ServiceWorkerHost.run`'s main-thread host composition —
`ClientEngine` + durable store + transports + `BroadcastMirrorChannel`
serving while elected, a `Client.connect` mirror over the same channel
while not. It hands back one `Client` that keeps working unchanged across
the mirror→host promotion (a switching `ClientView` swaps the underlying
tier, replaying explicit subscriptions and re-hydrating live
`observe`/`related` streams) and a `role: Stream<"host" | "mirror">` for
devtools/debug UI. A promoted tab boots against the SAME durable store —
same journal, rows, and cookie — so the CVR conversation resumes rather
than restarting. Environments without `navigator.locks` get a documented
fallback (becomes host immediately), not a polyfill.

`@thomasfosterau/legation-effect`'s `Mirror` now fails any request still in flight when
the host it was talking to is gone — either because the mirror's own scope
closed, or because a second `HostReady` announces the host restarted — with
a clear `TransportError` instead of leaving the caller's `mutate` /
`mutateWithAck` / server-fallthrough `read` call hanging forever. A
mutation already journaled by the old host before it died is never lost:
it's durable in the shared store and the next host's sync loop picks it up
regardless of what this caller was told.
