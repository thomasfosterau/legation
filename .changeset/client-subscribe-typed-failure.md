---
"@thomasfosterau/legation": patch
---

`Client.subscribe` now fails with the view's typed `ClientViewError` when the view refuses a window's registration (a mirror or store failure), instead of dying with a defect. The refused pin is not counted, so a later `subscribe` registers the window afresh. An observed read whose registration is refused still ends its stream with a defect, with the ledger rolled back.
