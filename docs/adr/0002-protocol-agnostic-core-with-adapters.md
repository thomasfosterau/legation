# ADR-0002: Protocol-agnostic core with protocol adapters

Date: 2026-06-03
Status: Accepted

## Context

The original library was JSON:API-specific: its types, fetch helpers, and storage all spoke JSON:API. The sync engine needs to serve consumers whose backends speak REST, GraphQL, RPC, or JSON:API.

## Decision

The core engine works on **generic keyed resources**: a `SyncKey` plus an opaque `unknown` value with version/timestamp metadata. Nothing in core knows about HTTP, resource types, or any wire format. Protocol-specific knowledge lives in adapter packages (`effect-sync-jsonapi` is the first) that translate their world into query/mutation descriptors and loaders.

The client/server wire protocol (`Protocol` module) is similarly value-agnostic: it moves `unknown` values addressed by sync keys; serialization concerns stay in transports.

## Consequences

- Any backend can plug in by writing loaders/writers; JSON:API users get a ready-made adapter.
- Cache entries can't be introspected generically (values are opaque); features that need value structure (e.g. normalized entity graphs) must be layered in adapters or a future normalization module.
- The JSON:API package keeps its standalone helpers for users who only want JSON:API utilities without the engine.
