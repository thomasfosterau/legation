---
"@legation/effect": minor
---

ADR-0023's topic-derived fan-out lands as a core seam (internal tier): `FanoutTopics` (the pure topic algebra — coarse `collection` topics plus fine `collection/field=value` topics restricted to the node's derivable set, with write derivation over old and new values), `FanoutBroker` (topic pub/sub with leased registrations; in-process reference implementation), and `FanoutBus` (an `InvalidationBus` over a broker, so `Server.make({ bus })` gets topic-precise cross-room fan-out unchanged). `ChangeHint` gains an additive `oldValues` field — the memory backend supplies it, so an update that moves a row between parents pokes both edge windows and a delete derives from the old row.
