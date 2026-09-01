---
"@legation/effect": minor
"@legation/svelte": minor
---

Keyed reactive mutation-state surface (#116) — TanStack Query's
`useMutationState` analogue. `ClientEngine.mutationStates` maintains a map
keyed by `mutationId`, seeded from the journal at boot (a reload shows
pending intents) and folded forward as mutations are journaled, acknowledged,
or permanently rejected — regardless of whether they went through `mutate`,
`mutateEncoded`, or `mutateWithAck` (previously only `mutateWithAck`-registered
mutations ever settled on `mutationEvents`/`engineEvents`; this fixes that
gap so the whole journal is observable). Terminal (acknowledged/rejected)
entries are retained only up to a configurable `mutationStateRetention.maxTerminal`
bound (default 200), evicted oldest-settled-first, so a mutation storm cannot
grow the map without limit — the journal stays the durable source of truth
for pending mutations.

Exposed at every layer:

- `ClientEngine.mutationStates: Stream<MutationStateMap>` and `MutationState.ts`'s
  pure fold (`seed`/`journaled`/`acknowledged`/`rejected`).
- `ClientView`/`Client` gain `mutationStates`, so it works identically over an
  owned engine and a connected mirror (ADR-0021) — a minimal mirror-protocol
  extension (`SubscribeMutationStates`/`UnsubscribeMutationStates` mirror→host,
  `MutationStatesUpdate` host→mirrors) broadcasts the whole map, refcounted
  like a subset subscription.
- `EngineAtoms.mutationStates` (the whole map) and `EngineAtoms.mutationsFor(mutator)`
  (a derived per-mutator selector).
- React `useMutationState(mutator?)` — always a plain array, oldest-journaled
  first, no `AsyncResult` handling needed.
- Svelte `useMutationState(mutator?)` rune (`@legation/svelte/Runes`), reactive
  to a `mutator` thunk like `useQuery`'s `read`.

The react-todo example's journal panel is rewritten over this surface,
replacing its bespoke `Introspection`-based wiring, and demonstrates bounded
terminal retention.
