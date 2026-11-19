---
"@thomasfosterau/legation": patch
---

A tab mirroring a host engine no longer calls an answer complete before the rows of the pull that covers it have reached the tab (#672). The host now sends a registration's current rows, and restarts its broadcast from a fresh observation, before it sends the mark that calls the registration pulled. A mirror also ignores a key's mark until that key's rows have arrived since it took an interest in it, so a mark broadcast for another tab's registration, or one from an older host, can't make it answer early. The mirror protocol is unchanged.
