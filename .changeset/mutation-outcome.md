---
"@legation/effect": minor
"@legation/browser": minor
"@legation/svelte": minor
---

Per-mutation outcome surface (#36). Callers can now await a mutation's
authoritative backend outcome — applied, or permanently rejected with a reason
(#35) — rather than only its journal ack.

- `ClientEngine.mutateWithAck` returns a `MutationHandle` whose `acknowledged`
  effect resolves with the `MutationOutcome` once the backend settles the
  mutation via a push or pull acknowledgement. `ClientEngine.mutationEvents`
  streams the lifecycle (`journaled`, then `acknowledged` or `rejected`). Plain
  `mutate`/`mutateEncoded` are unchanged and register no deferred; pending
  acknowledgements are interrupted on engine scope close, so they never hang.
- React gains `useMutationWithAck` (over an additive `EngineAtoms.mutationWithAck`
  atom); Svelte gains `getMutateWithAck`. Both return a promise of the outcome.
- The tab mirror forwards the outcome: `MirrorProtocol` gains an additive
  `MutateSettled` host→tab message, `EngineHost` awaits the backend verdict on a
  scoped fibre and posts it, and `TabMirror.mutateWithAck` awaits it (the
  existing journal-ack `mutate` is unchanged).
