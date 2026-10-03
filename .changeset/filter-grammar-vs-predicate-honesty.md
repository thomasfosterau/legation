---
"@thomasfosterau/legation-jsonapi": minor
---

Issue #218: the filter grammar (effect-jsonapi's query-parameter format) and
`Predicate` (legation's own subset language) are two different things, not
one language with an internal engine form — `CONTEXT.md` and ADR-0016 are
corrected to say so; ADR-0028, `Predicate`, every interpreter and the
generated corpus are unchanged.

`JsonApiQuery.fromFilterAst(ast)` no longer claims to be total and no longer
throws for a literal outside `string | number | boolean | Date`: it now
returns `Result.Result<Predicate.Predicate, QueryError>`, so a caller
bridging a filter AST built over a resource with a richer decoded attribute
type gets a typed failure instead of an uncaught exception. Its doc comment
now states the field-namespace precondition (field names are copied
verbatim, correct only because a caller pre-synthesises a resource whose
fields are already the engine's) and names the `Date → toISOString()` step
as a load-bearing encode (ADR-0028 rule e), and states plainly that
`toFilterAst` is not its inverse. `JsonApiQuery.parseParams` /
`JsonApiQuery.canonical` are unaffected in observable behaviour: both call
sites' literals are always wire scalars by construction (decoded through
the node-derived synthetic resource, or copied from a `Predicate.Literal`),
so the typed failure is unreachable there — the change makes that
unreachability an enforced fact instead of an assumption, and gives the
exported function's own general contract a typed failure instead of a
thrown defect.

A new property test exercises the Date encode step directly (the existing
`FilterCorpus`-generated corpus can never produce a `Date`, since
`Predicate.Literal` is a closed wire-scalar union, so it could not catch a
regression there) and checks it against the wire text a resource that
actually declares a `Date`-decoded attribute would send — the façade/REST
equivalence obligation of ADR-0029 §6.
