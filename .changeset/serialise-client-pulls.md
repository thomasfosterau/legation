---
"@thomasfosterau/legation-effect": patch
---

`ClientEngine` now runs pulls one at a time. Before, a pull issued while another
was in flight did not wait for it: two pulls could leave with the same cookie,
and their responses could be applied in either order, so an older response
applied last reverted the rows and the cookie. Now a poke that arrives during a
pull, and any pull requested in the meantime, share one follow-up pull, and an
explicit `pull` resolves only after a pull started after the call has been
applied. A pull requested when the engine's scope closes is interrupted rather
than left waiting.
