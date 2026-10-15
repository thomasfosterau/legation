---
"@thomasfosterau/legation-effect": minor
---

`BackendContract.verifyBackendContract` gains two optional options, `restoredLedger` and `restoredPeerLedger`, for a run over a backend restarted on a ledger that already acknowledges the contract's client. They carry the ledger ids the restart expects for the contract client and for rule 11's peer group. The contract first checks that the backend reports exactly the restored id, and fails with a rule that names a forgotten or differing ledger when it does not. It then numbers every rule's mutations from that id. A backend that forgets its ledger on restart now fails the contract when the run passes `restoredLedger`.

Without the options the run expects a fresh client group, as before: every rule and its expectations are unchanged. Two checks are new on that path: the contract client must report 0 before the first rule runs, and rule 11's peer group must report 0 before it parks its handler. A backend that reports a non-zero ledger for either group on a fresh group now fails with the matching rule.
