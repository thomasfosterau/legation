---
"@legation/effect": patch
"@legation/browser": patch
"@legation/node": patch
"@legation/jsonapi": patch
"@legation/sql": patch
"@legation/cloudflare": patch
"@legation/svelte": patch
"@legation/devtools": patch
---

README: the `effect` floor (`4.0.0-rc.118`) is now tested on every pull
request, where CI runs the test suite against it, instead of in a weekly
canary. The peer range (`effect >=4.0.0-rc.118`) and the tested pin (`4.0.0`)
are unchanged.
