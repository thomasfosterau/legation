---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiQuery.flatFilter` (and `buildQueryString`, which uses it) keeps the codecs it builds for the 256 most recently used filter shapes, where it kept one for every shape the process ever encoded. The encoding is unchanged.
