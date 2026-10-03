---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
---

The mirror seam sheds its browser-tab coupling: the party served by
`EngineHost` is any client context — a browser tab, an Electron window,
an extension, a CLI instance — so the vocabulary now says what the
contract means. `TabMirror` is `Mirror` (module, namespace, and type),
`tabId` is `mirrorId` (wire field included), `TabMessage` is
`MirrorMessage` (`decodeTabMessage` → `decodeMirrorMessage`), the host's
liveness option `tabTimeout` is `mirrorTimeout`, and
`MirrorChannel.makeLoopbackPair` returns `{ host, mirror }`. Clean
break, no aliases; `@thomasfosterau/legation-browser` re-exports the new names.
