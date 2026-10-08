---
"@thomasfosterau/legation-effect": patch
---

`SyncServer`'s push handler no longer loses a fan-out when it is interrupted.
The backend commit and the publish of its change hints now run as one
uninterruptible region, so an interrupt that lands after the commit still
publishes the hints. Before, an interrupt between the two (a client dropping
mid-push, say) left the change committed but never poked the other client
groups, and a replayed retry carries no hints to repair it. The trade-off: a
slow `applyMutations` can no longer be cancelled mid-push; an interrupt waits
for the commit and its publish to finish.
