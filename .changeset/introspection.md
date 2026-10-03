---
"@thomasfosterau/legation-effect": minor
---

Add engine and server introspection (#45).

- **Unified `EngineEvent` stream**: `ClientEngine.engineEvents` emits the whole
  sync lifecycle from a single internal hub — `MutationJournaled` /
  `MutationAcknowledged` / `MutationRejected` (the #36 events), `PushStarted` /
  `PushCompleted`, `PullStarted` / `PullCompleted`, `PokeReceived`, and
  `ViewRebuilt` (carrying the scoped collections). `mutationEvents` (#36) is now
  a filtered projection of this one hub, so there is a single source of truth;
  its behaviour is unchanged. The hub stays unbounded for the reason #44 kept
  the mutation hub unbounded — lifecycle events are low-volume, consumer-driven,
  and lossless (observability, not reconstructable via pull).

- **`EngineIntrospection`** (`Introspection.ts`): a read-only view over a
  `ClientEngine` and its `ClientStore` — `subscriptions` (active subsets,
  including resolved named subscriptions), `journal`, `cookie`, `collections`,
  and `events`. Built over the engine's public read accessors (new
  `activeSubscriptions` / `engineEvents` members) and the store's public reads,
  so it never touches private state. Every member is a plain `Effect`/`Stream`,
  so it drives cleanly through `PromiseFacade`.

- **Server introspection** (`SyncServer.makeWithIntrospection`): a read-only
  `ServerIntrospection` over the live fan-out state — active client groups with
  their authorised subsets and CVR sizes, plus poke counters. Fan-out behaviour
  is unchanged.

- **New `legation_*` metrics**: `legation_journal_depth` (gauge, sampled on
  append/acknowledge), `legation_rebase_duration_ms` (histogram, around the
  overlay rebuild), `legation_fanout_latency_ms` (histogram, the server fan-out
  leg), `legation_pull_patch_ops` and `legation_push_mutations` (histograms).
