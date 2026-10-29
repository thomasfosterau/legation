---
"@thomasfosterau/legation-jsonapi": minor
---

`NodeBridge` reads more sync metadata off the resource itself (#220). A `paginated` relationship's edge order comes from its own declaration, `Relationship.paginated(ref, { order })`, so `options.order` is no longer required. Two `@legation/` resource annotations, built with `NodeBridge.syncAnnotations({ inverses, kinds })`, name an inverse edge (`@legation/inverses`) and give a filterable field its literal kind (`@legation/kinds`, for an `instant` stored as text). They survive `Resource.annotate` and `Resource.extend`. `FromResourceOptions` stay as explicit overrides and win over the resource's declaration. A malformed annotation, or a kind for a field the resource does not declare filterable, throws `ResourceBridgeError` when the graph is built.
