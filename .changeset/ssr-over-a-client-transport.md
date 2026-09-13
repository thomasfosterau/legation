---
"@legation/effect": minor
"@legation/cloudflare": minor
"@legation/svelte": minor
---

SSR snapshots over a `ClientTransport`, and a Cloudflare service-binding
carrier to take them (#211).

`Hydration.snapshot` no longer requires an in-process `ServerHandler`: pull is
the correctness path, so subscribe → pull → dehydrate works identically
against a remote Server. Pass `transport` and the render needs nothing from
context; omit it and the in-process path is unchanged — a loop-back transport
over the in-context handler. `loadSnapshot` in `@legation/svelte/kit` takes
the same option, so an Effect-based `load` can render against a backend in
another Worker.

`@legation/cloudflare` adds `BindingTransport`: the sync protocol over a
service binding (`env.API.fetch`), for the ordinary two-Worker shape where the
Worker rendering the page is not the Worker holding the database. It forwards
the inbound cookie and origin so the bound Worker resolves the same caller —
and therefore the same room — the browser will reach on its own first pull.
Getting that wrong is silent: the snapshot still carries the right rows while
its cookie belongs to another room's CVR, degrading every first pull to the
reset path. The package's tests pin both sides of it.
