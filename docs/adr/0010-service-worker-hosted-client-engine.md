# ADR-0010: Service-worker-hosted client engine with per-tab mirrors

Date: 2026-06-12
Status: Accepted

## Context

A persistent, offline-first client with multiple tabs needs exactly one writer/syncer per browser profile, or tabs duplicate subscriptions, race on the journal, and strand pending mutations in closed tabs. Replicache solved this with client groups + leader election (Web Locks); TanStack DB's persistence layer does the same. Browsers already provide a per-origin singleton with its own lifecycle: the service worker — which this library independently targets for HTTP caching.

## Decision

The recommended browser deployment hosts the sync engine in a service worker:

- The engine (collections, journal, sync loop, subscriptions) runs in the SW; durable state lives in IndexedDB. The engine is **crash-tolerant by construction**: service workers are killed and restarted aggressively, so every state transition is durable and the engine rehydrates from IndexedDB on wake. Background Sync / Periodic Background Sync drive offline write retry and periodic pulls.
- **Tabs hold an in-memory mirror** of their subscribed rows, hydrated from IndexedDB on load and updated by engine broadcasts (BroadcastChannel/postMessage). Live queries and the optimistic overlay run synchronously in the tab against the mirror; mutations forward to the SW journal. Tab↔SW messaging is one more implementation of the sync-transport seam.
- The same SW also runs the separate HTTP cache module (Cache API), so collection changes can invalidate cached HTTP responses in one place.
- The engine stays **host-agnostic**: the same core runs on the main thread (no-SW browsers, simple apps), in Node, and in tests; the SW host is a browser-package layer, not a core assumption.

## Consequences

- No leader election: the platform provides the singleton. Closed-tab pending mutations survive in the SW's journal.
- One subscription set and one sync loop per origin regardless of tab count.
- SW lifecycle becomes the engine's hardest operational constraint: everything must tolerate being killed mid-flight (idempotent pulls via cookies, journaled pushes via mutation ids — both already required by ADR-0008).
- Mirror consistency machinery (hydrate + broadcast + rebase in the tab) is real work; it reuses the same patch/rebase pipeline as the network path.
- Apps that can't use a SW (some embedded webviews) run the main-thread host with per-tab persistence namespaces — a documented degraded mode.
