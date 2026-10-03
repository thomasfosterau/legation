---
"@thomasfosterau/legation-jsonapi": patch
---

Correct the account of what effect-jsonapi 0.15 changed in URL parsing (the
`effect-rc-floor` changeset mentioned only `filter`). Every comma-list query
parameter the façade, `JsonApiQuery.parseRead` and the REST handlers decode
now accepts the repeated-key spelling instead of answering 400: the shorthand
`filter[f]`, `sort`, and `fields[TYPE]`. Each repeated
form, and any mix of repeated and comma forms, decodes to the same read as
the single comma list (`?sort=-name&sort=id` ≡ `?sort=-name,id`,
`?fields[products]=name&fields[products]=description` ≡
`?fields[products]=name,description`). Positions that take exactly one value still reject a repeated key with a 400:
`page[...]`, a scalar operator such as `filter[f][gt]`, and the group form's
`[conjunction]` / `[path]` / `[operator]`. Encoding is unchanged: always the canonical comma
form.
