---
"@thomasfosterau/legation-jsonapi": patch
---

`Derive.RowSchema` is now a real row codec instead of a `Record<string, unknown>` cast to the row type. It checks a row's `id` (a string) and its `relationships` linkage (a resource identifier, a list of them, or `null`), and passes every other field through as is. A row built by `Derive.toRow` decodes unchanged. A row with no `id`, or with malformed linkage, now fails to decode. Its type, `Schema.Codec<JsonApiRow>`, is unchanged.

`CollectionLoader.RelationshipRef`, `DocumentWriter.RelationshipValue`, `DocumentWriter.DataDocument` and `Relationships.RelatedValue` are now built from private modules. Their names and types are unchanged.
