---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-svelte": patch
---

Carry the enhanced form submit across the mirror protocol (#536). `Client.beginFormMutation` (and `/kit`'s `enhanceFormMutation`) now works over `Client.connect`: the mirror asks its host to begin the form mutation, and settles or abandons it on the receipt. The host's engine holds the in-flight entry, so its overlay and unpulled tail serve every mirror, and the effect is still released by the pull that covers the form client, not by the action's response. A mirror that disconnects or is swept abandons the entries it held.

`ClientEngine` gains `beginFormMutationEncoded`, the form submit's counterpart of `mutateEncoded`: the host decodes the args the mirror encoded rather than encoding them again, so a Mutation whose args schema transforms (such as `Schema.NumberFromString`) works over a mirror. When the host's store fails to park an acknowledged entry, the engine now still rebuilds its overlay and pulls, and the failure reaches the caller's `settle` as a `StoreError`.

Wire format: the begin travels as a `Mutate` naming the reserved mutator `MirrorProtocol.FORM_MUTATION_MUTATOR`, and the new `EndFormMutation` (mirror → host) and `FormMutationBegun` / `FormMutationFailed` / `FormMutationEnded` (host → mirror) messages carry the rest. The form replies name the mirror they answer, since host messages reach every mirror and each numbers its requests from zero. A host that predates this answers the begin as an unknown mutator, and the mirror reports that as a `TransportError` saying the host must be upgraded, instead of waiting for an answer that never comes. No app mutator may use the reserved name.
