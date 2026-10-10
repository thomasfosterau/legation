---
"@thomasfosterau/legation-effect": patch
---

A push that takes the acknowledged-but-unpulled tail to half its bound now starts
a pull ahead of the overflow, so a healthy transport never reaches the bound
(#337). Before, with no pokes and no `pullInterval`, nothing pulled on its own,
so a long run of pushes could fill the tail and release its oldest overlay
entries early, reverting the view until a pull landed. The pull runs in the
engine's scope and the push does not wait for it; at most one such pull is in
flight, and a failed one does not block the next.
