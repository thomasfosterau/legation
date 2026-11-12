---
"@thomasfosterau/legation": minor
---

Typed query results from the node graph (#140). A read declared `as const satisfies Query.Read` (or written inline) keeps its literal collection, `include` keys and `order` tokens, and `Client.query` / `Client.observe` type its rows from the graph: `row.value` is the node's row (`Node.RowOf`), `row.related` carries exactly the included edges — a `one` edge's row or `null`, a `many` / `paginated` edge's rows — and reading an edge the read did not include is a compile error. The read is checked against the graph where it is used (`Query.Validate`): a collection, edge, `where` field or `order` token the graph does not declare fails to compile, naming the key. A dynamic read (`collection` typed `string`) is unchecked and resolves to untyped rows, as before.

- `Node.registry` returns `Node.NodeRegistry<Nodes>`, carrying the union of its nodes' types; `Node.NodesOf`, `Node.NodeOf`, `Node.TypeOf`, `Node.FieldOf`, `Node.EdgeOf` and `Node.IsTyped` read it.
- `Client.Client<Graph>`; `Client.make`, `Client.connect` and `Client.fromView` return a Client typed by the `nodes` they are given (`Client.Made<Graph>`, `MakeOptions<Graph>`, `ConnectOptions<Graph>`). `Client.Client` alone is a Client over any graph, and a typed Client is assignable to it.
- `Client.ResolvedRow<R, Graph>` is the typed row (`Client.ResolvedRow` alone is the untyped one); `Client.QueryOf` / `Client.ObserveOf` / `Client.RelatedOf` spell the method and edge types.
- `Register` (root entry): the app registers its graph once by declaration merging (`declare module "@thomasfosterau/legation" { interface Register { readonly nodes: typeof nodes } }`) for the framework hooks that find the Client in context; `Client.Registered` reads it.
- `Query.make` keeps the read's literal type; `Query.Read`'s `where` and `include` are spelled as readonly index signatures (the same shape).
- `Hydration.rowsFor(snapshot, nodes, read)` checks the read and types its seed rows (`Hydration.SeedRow`), which now carry an empty `related`, so they seed a typed hook's `initial` directly.

**Breaking** (types only; no runtime or wire change): `Client.query` / `observe` on a typed Client reject a read that misnames a collection, edge or field, and return typed rows where they returned `ResolvedRow` (code that cast `row.value` keeps compiling; code that indexed `row.related["edge"]` for an edge the read does not include no longer does). A helper that forwards a checked read takes `read: R & Query.Validate<Graph, R>` and passes `R` on explicitly (`client.query<R>(read)`). `Node.NodeRegistry`, `Client.Client`, `Client.Made`, `Client.MakeOptions` and `Client.ConnectOptions` gained a type parameter (defaulted).
