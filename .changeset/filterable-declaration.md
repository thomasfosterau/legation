---
"@legation/effect": minor
"@legation/jsonapi": patch
---

Close the sync tier's filter surface with a per-node **filterable set** (ADR-0028
rule d, #154).

- `Node.make` gains `filterable` (per attribute: the operators a client may use
  — `eq ne lt lte gt gte in nin isnull` — optionally with an explicit literal
  kind) and `sortable`. The resolved declaration is on `Node.filterable` /
  `Node.sortable` and travels onto the derived `Collection` like `indexes`, so
  the server enforces it without Node definitions.
- Defaults: `id` and every `one`-edge `via` field are filterable by `eq` / `in`
  (kind `text`; a declaration naming a key field widens it, never replaces
  it); `sortable` always includes `id`, and `Node.registry` adds every
  paginated edge's `order` fields to its target's `sortable`, since the
  per-parent edge windows sort by them. The literal kind of a declared
  attribute is derived from its schema's encoded form (`String` → `text`,
  `Number` → `double`, `Schema.Int` → `integer`, `Boolean` → `boolean`); an
  `instant` must be declared explicitly. A declaration naming a field the row
  does not carry, or an attribute whose kind cannot be derived, throws a
  `FilterDeclarationError` at definition time.
- `Authorization.policy(filters, { collections })` carries the declarations;
  `authorize` checks every client-authored `where` / `orderBy` against them
  **before** the auth filter is AND-ed in and before `Backend.evaluate` runs:
  an undeclared field, a declared field with an undeclared operator, a literal
  of the wrong kind, a client-supplied `Exists`, or an unsortable `orderBy`
  fails the pull or read with an `AuthorizationError` naming the collection,
  field and operator. Today's wire forms `Not(In)` and a null-literal
  `Compare` are checked as `nin` and `isnull`. The check runs on the request
  as the client sent it: the auth filter's own predicate, what a
  `SyncMiddleware` rewrites in, and named-query resolver output are
  server-authored and exempt. A policy built without `collections` keeps the
  previous open behaviour.
- `NodeBridge.fromResource` / `registry` accept `filterable` / `sortable` per
  resource until effect-jsonapi carries the per-attribute annotation.
