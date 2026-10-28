---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-svelte": patch
---

Carry the enhanced form submit across the mirror protocol (#536). `Client.beginFormMutation` (and `/kit`'s `enhanceFormMutation`) now works over `Client.connect`: the mirror asks its host to begin the form mutation, and settles or abandons it on the receipt. The host's engine holds the in-flight entry, so its overlay and unpulled tail serve every mirror, and the effect is still released by the pull that covers the form client, not by the action's response. A mirror that disconnects or is swept abandons the entries it held.

Wire format: the begin travels as a `Mutate` naming the reserved mutator `MirrorProtocol.FORM_MUTATION_MUTATOR`, and the new `EndFormMutation` (mirror → host) and `FormMutationBegun` / `FormMutationFailed` / `FormMutationEnded` (host → mirror) messages carry the rest. A host that predates this answers the begin as an unknown mutator, and the mirror reports that as a `TransportError` saying the host must be upgraded, instead of waiting for an answer that never comes. No app mutator may use the reserved name.
