---
"@thomasfosterau/legation": patch
---

A streaming host request no longer waits forever on a host that never answers (#628). The host now replies `Started` as soon as it accepts a streaming request, and `Mirror.stream` fails with `Unanswered` when no first reply arrives within `requestTimeout`; after that a stream may stay quiet as long as it likes. `HostResponseOutcome` gains the additive `Started` case: a host that predates it is acknowledged by its first `Item`, `End` or `Failure`, and a mirror that predates it ignores the reply.
