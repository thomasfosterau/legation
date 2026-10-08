---
"@thomasfosterau/legation-effect": patch
---

The Redis Streams broker no longer skips hints. A subscriber used to re-issue
`XREAD BLOCK ... $` after each block timeout, and `$` resolves to the stream's
end at each call, so a hint published between a timeout and the re-issue was
never read by that subscriber. The broker now resolves its start position once,
when the subscription is made (`XREVRANGE ... COUNT 1`, or `0-0` for an empty
stream), and every later read continues from the last ID it saw. The `"$"`
option keeps its meaning: only hints published after `subscribe` returns are
delivered. Publishing stays best-effort, so the gap only delayed convergence
until the next pull; the broker now closes it.
