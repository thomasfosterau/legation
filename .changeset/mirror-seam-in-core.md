---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
---

The mirror seam moves to core, where ADR-0006's dependency rule places it:
`MirrorProtocol`, the `MirrorChannel` interface + loopback pair,
`EngineHost`, and `TabMirror` are exported from `@thomasfosterau/legation-effect` — none
of them needs a browser global, so Electron windows, extensions, and CLI
processes can host or consume mirrors without `@thomasfosterau/legation-browser`. The
browser package keeps what is actually browser-coupled — the new
`BroadcastMirrorChannel.make(name)` binding (formerly
`MirrorChannel.makeBroadcastChannel`) and `ServiceWorkerHost` — and
re-exports the moved modules for compatibility.
