---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-browser": patch
---

`dist/` is emitted one module per source module rather than as merged chunks, so a bundler drops every module an app doesn't reach (#678). The entries and their exports are unchanged; the other packages keep their bundled `dist/` for now.
