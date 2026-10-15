---
"@thomasfosterau/legation-effect": patch
---

`BackendContract.verifyBackendContract` runs over a backend restarted on a ledger that already acknowledges the contract's client. The contract starts from the `lastMutationIds` the backend reports for that client, and numbers every rule's mutations from there, including the peer group rule 11 commits from. Before, rule 1 expected the client's ids to be 1 and 2, so a backend restarted over its own durable ledger failed it. On a fresh client group the start is 0 and every expectation is unchanged. The change only admits a non-fresh start, which is why it is a patch: no check is weakened and no published API changes.
