---
"@thomasfosterau/legation-effect": patch
---

`ClientEngine` runs pulls one at a time. Before, a pull issued while another was in flight did not wait for it, so two pulls could leave with the same cookie and an older response applied last could revert rows and the cookie. Now a pull waits for the pull in flight, and an explicit `pull` resolves once a pull that started after the call has been applied, so a call is never answered from data older than itself. Pokes that arrive during a pull share one follow-up pull. Pulls still run in the caller's fibre, so the caller's context and interruption behave as before.
