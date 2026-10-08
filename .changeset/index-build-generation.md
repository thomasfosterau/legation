---
"@thomasfosterau/legation-effect": patch
---

Fix a secondary index that could keep pre-pull rows. An index build reads a
collection's confirmed rows, yields, then installs; a pull whose patch changed
an indexed field of that collection could land in that window, and the stale
index was installed and kept until the next rebuild, so indexed queries could
return rows that no longer match (or miss rows that now do). Each collection now
carries a generation that every confirmed-row write (and every field-set change)
bumps; a build discards its result and retries when the generation moved during
its read, and falls back to a full scan after repeated races.
