---
"@thomasfosterau/legation-svelte": minor
---

Add `useAnswer(() => read)`, a live `Client.Answer` (`{ rows, completeness }`, from `Client.observeAnswers`): `useQuery`'s rows with whether they are complete or, while the read's windows are not pulled yet, partial (#653). The read is checked and its rows typed against the registered graph as `useQuery`'s are, and it opts out the same way.
