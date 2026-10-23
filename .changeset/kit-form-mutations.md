---
"@thomasfosterau/legation-svelte": minor
"@thomasfosterau/legation-effect": minor
---

Form actions run named Mutations (ADR-0030, amendment #215).

`@thomasfosterau/legation-svelte/kit` adds:

- `mintFormClient` for the page that renders a form (a fresh form client id
  with mutation id `1`, rendered in the `FORM_CLIENT_FIELD` and
  `FORM_MUTATION_FIELD` hidden fields);
- `formMutationTarget`, which reads the client group from its cookie (never
  minted there) and the form client from the posted fields;
- `runFormMutation`, which hands the form layer's decoded args to
  `server.mutate` and answers the receipt the action returns under
  `RECEIPT_KEY`;
- `enhanceFormMutation`, the enhanced submit for `use:enhance`. Each submit
  mints a fresh form client, overlays the Mutation's effect, and settles on
  the receipt. SvelteKit's post-action `load` re-run is off by default.

An action without the client-group cookie stays an out-of-band writer. The
client-group cookie's default name is now exported as `CLIENT_GROUP_COOKIE`.

`@thomasfosterau/legation-effect` adds the enhanced submit's client half:

- `ClientEngine.beginFormMutation` and `Client.beginFormMutation` apply a
  Mutation's local handler to the overlay under a form client's id without
  journaling it, and return a submission to settle on the action's receipt.
- An `acknowledged` receipt moves the entry to the unpulled tail. The pull
  whose `lastMutationIds` covers the form client releases it, as it does a
  pushed mutation.
- A `rejected` receipt drops the entry, and `abandon` drops it when the action
  did not answer. Either way a pull is signalled.

The entry holds a place in the tail's bound from the start, and only in
memory. Over a connected host (a mirror) `Client.beginFormMutation` fails with
a `TransportError`.
