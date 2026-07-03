---
"@legation/effect": patch
---

Fix a race in `Related.observeWith` that could leave a live join permanently
stale: a foreign-row write landing between the join's index priming and its
foreign observers subscribing was swallowed by the observers'
initial-emission drop, and nothing re-emitted until the next foreign write.
The observers' initial current-rows emission is no longer dropped — an
unchanged rebuild re-hydrates to the same join and dedups away via
`changesWith`, while a racing write now correctly re-emits.
