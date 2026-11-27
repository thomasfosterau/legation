---
"@thomasfosterau/legation": minor
---

`ClientEngine.EngineEvent` and `RowChange` gain `$is` / `$match` tag helpers beside their plain tagged unions: `ClientEngine.EngineEvent.$is("PullCompleted")` narrows an event and `ClientEngine.EngineEvent.$match(event, { … })` matches every tag; `RowChange.$is("exit")` and `RowChange.$match({ … })` do the same for a row change, keeping its row type. The unions, and how their values are built, are unchanged.
