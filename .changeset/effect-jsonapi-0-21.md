---
"@thomasfosterau/legation-jsonapi": minor
---

BREAKING: requires `@thomasfosterau/effect-jsonapi` `^0.21.0` (was `^0.17.0`). A filterable `id` is now declared on `Resource.make`'s `id` option with `Filter.able`, never as an attribute (effect-jsonapi reserves the name), so `filter[id]` decodes through the resource id's declared operators. Servers built on effect-jsonapi 0.18 or later refuse client-generated ids by default; since `JsonApiBackend` always sends one on create, give `Endpoint.create` and `Endpoint.operations` a `payload` that accepts `data.id` (see the README's "Atomic operations").
