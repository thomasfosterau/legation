---
"@thomasfosterau/legation-svelte": minor
---

`createClient` boots a Client over an engine hosted elsewhere, and hands it the page's SSR snapshot (#146, #147).

- `createClient({ nodes, mutations, channel, snapshot?, subscribe?, hydrateTimeout? })` (`ConnectClientOptions`) returns a `ConnectedClientHandle`: the Client is a mirror of the engine on `channel` (a `MirrorChannel`, or the effect that opens one, such as `BroadcastMirrorChannel.make(name)`). The snapshot is offered to the host before anything is subscribed, re-sent every half second while no host answers, for at most `hydrateTimeout` (default 5 seconds); the host hydrates its store only when it is empty and has not pulled. `handle.hydration` is the host's answer (`Option` of `Hydration.HydrateOutcome`).
- The README says when to reach for a snapshot and when for `initial` seeding.
