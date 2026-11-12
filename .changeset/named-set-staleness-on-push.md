---
"@thomasfosterau/legation": patch
---

A push now marks the named sets (#205) over the collections it wrote stale before it answers, so the next pull re-resolves them. Before, the fan-out did this on a forked fiber, and a pull issued straight after an unfollow could still bind the set's old members and deliver rows the viewer no longer had access to, once (#652). The fan-out still records the same writes from the hints, which is how another server's writes reach this one.
