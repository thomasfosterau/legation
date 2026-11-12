---
"@thomasfosterau/legation-svelte": minor
---

`useQuery` and `useConnection` type their rows from the read and the app's registered graph (#140). Register the graph once beside it (`declare module "@thomasfosterau/legation" { interface Register { readonly nodes: typeof nodes } }`), declare reads `as const satisfies Query.Read`, and `useQuery(() => allProducts)` yields rows whose `value` is the products row and whose `related` carries exactly the included edges, with no cast and no type argument. A read that names a collection, edge or field the graph does not declare fails to compile at the hook (`useAggregate` and `useAggregateGrouped` check their reads too). With no graph registered, or for a dynamic read, rows are untyped, as before.

**Breaking** (types only): `useQuery`, `useConnection`, `useAggregate` and `useAggregateGrouped` are generic in the read (`const R extends Query.Read`); `ResolvedRows<R>`, `Connection<R>` and `ConnectionOptions<R>` gained a defaulted type parameter; with a graph registered, an `initial` seed must have the typed row shape (`Hydration.rowsFor` produces it).
