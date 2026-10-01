# ADR-0004: Invalidation marks entries stale instead of deleting them

Date: 2026-06-03
Status: Accepted — narrowed to the HTTP cache module by [ADR-0008](0008-mutation-log-rebase-with-cvr-patches.md)

## Context

Cache invalidation can either remove entries or mark them stale. Removal frees memory immediately but destroys data that could be shown while refetching (a worse UX, especially offline). TanStack Query's model — invalidation = mark stale, refetch on next observation — is widely understood by the target audience.

## Decision

`SyncCache.invalidate` and `invalidateTags` rewrite matching entries with `staleAt = now` and publish an `Invalidated` cache event. Entries are only removed by explicit `remove`/`clear` calls or by expiry (`expiresAt`/TTL).

## Consequences

- Stale data remains available for stale-while-revalidate flows and offline reads.
- Memory is reclaimed via TTL/eviction, not invalidation; long-lived processes should set `timeToLive` or use a bounded store (`MemoryCacheStore` `maxEntries`).
- Observers distinguish "data changed" (`Updated` event) from "data needs refresh" (`Invalidated` event).
