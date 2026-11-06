---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-cloudflare": minor
---

Schema constants are named after the domain type they decode, with a
same-named type beside each: `Protocol.MutationSchema` is now
`Protocol.Mutation` (value and type), and likewise `PushRequest`,
`PushResponse`, `RejectedMutation`, `PatchOp`, `NamedSubscription`,
`PullRequest`, `PullResponse`, `ReadRequest`, `ReadResponse` and `Poke`;
`Subset.Subset` and `Subset.OrderBy`; `ClientStore.StoredRow`;
`Hydration.Snapshot` and `Hydration.SnapshotRow`; `Cvr.WireCvr`;
`MirrorProtocol.EdgeSelect` and `MirrorProtocol.MutationStateEntry` (was
`MutationStateSchema`); the JSON:API `JsonApiSchema.Links`, `LinkObject`,
`ResourceIdentifier`, `Relationship`, `ResourceObject`, `JsonApiError` and
`JsonApiDocument`; and the Cloudflare `RoomProtocol.ShardPoke`, `Register` and
`Publish`. `Derive.CreateArgs` / `UpdateArgs` / `DeleteArgs`, the room
protocol's bodies and `Hydration.SnapshotFromJson` gain their matching types.
