# legation vs SwiftData (+ CloudKit) and Room (+ Firestore)

The native platforms ship their own answer to "typed local store with live
queries": [SwiftData](https://developer.apple.com/documentation/swiftdata)
on Apple platforms (`@Model` classes, `@Query` views that re-render when the
store changes) and [Room](https://developer.android.com/training/data-storage/room)
on Android (SQLite DAOs whose queries are observable `Flow`s). Reads-wise
these are legation's closest cousins anywhere in this series — closer than
any web library. The comparison is really about the _other_ half: what
happens when the data has to leave the device.

One caveat up front, because this document would be dishonest without it:
**legation is a web library.** Swift and Kotlin client ports were designed
(ADR-0012, ADR-0013) and then withdrawn to keep the project web-only; the
supported path for a native app today is a bespoke client against the
exported protocol spec (ADR-0017). This comparison is therefore mostly a
comparison of _models_, and only secondarily a "choose one" — on iOS or
Android you are not choosing legation off the shelf.

Vocabulary note: terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## The read model: already agreeing

[`coming-from-tanstack-query.md`](coming-from-tanstack-query.md) puts it
directly: legation "is the SwiftData `@Query` model, not the TanStack
refetch model". All three systems hold a typed local store and treat reads
as live views over it:

|               | SwiftData                                | Room                                    | legation                                                   |
| ------------- | ---------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Typed rows    | `@Model` classes (macro over Core Data)  | `@Entity` classes + DAOs                | **Collections** typed by Effect Schema                     |
| Live reads    | `@Query` re-renders SwiftUI views        | DAO queries returning `Flow`            | **Live queries** / `observe` streams; rune & hook bindings |
| Local writes  | Mutate objects in a `ModelContext`, save | DAO `@Insert`/`@Update` in transactions | **Mutators** — named intents, journaled, optimistic        |
| Relationships | `@Relationship` object graphs            | `@Relation` / foreign keys              | Declared collection relationships (`Related` joins)        |

The differences within the read half are idiom, not philosophy. SwiftData
and Room track object graphs and let you mutate instances in place;
legation rows are immutable values replaced by **patches** and the
**optimistic overlay**, which is what makes **rebase** (drop overlay, apply
patch, replay pending mutations) a pure recomputation. The withdrawn port
ADRs are a good tour of how directly the model translates: `@Query` ↔ an
`@Observable` live query, Room's `Flow` ↔ `observe`, actor/Mutex isolation
↔ the service worker's single-writer role.

## The sync half: where the philosophies split

Neither SwiftData nor Room syncs by itself. Each platform has a default
answer, and both defaults are **state-based, last-writer-wins**:

- **SwiftData + CloudKit** (`ModelConfiguration(cloudKitDatabase:)`):
  automatic sync of the model graph through the user's private iCloud
  database. Powerful and nearly free — and constrained: iCloud accounts
  only, Apple's servers only, no server-side logic of yours, opaque
  scheduling you cannot force, schema restrictions (optionals/defaults
  everywhere, no unique constraints), and conflicts resolved by
  per-field last-writer-wins merge. There is no concept of a rejected
  write: whatever the device says, eventually, wins or merges.
- **Room + your choice**, most commonly [Firestore](https://firebase.google.com/docs/firestore)
  (which brings its own offline cache and, again, last-writer-wins
  documents) — or hand-rolled sync against your API, which is exactly the
  journal/ack/replay machinery legation exists to make library code.

legation's sync is **intent-based**: the unit crossing the network is not
"the new state of this object" but a named **mutation** with arguments,
applied _authoritatively on your backend_ — which can validate, enforce
permissions, and compute different effects than the client did (the
commerce example's `order/place` recomputes the order from the
authoritative cart server-side). Conflicts resolve by **rebase** — replaying
your intent over newer state — rather than by field merge, and the server
can _permanently reject_ a mutation, something LWW systems structurally
cannot express. The cost is owning a backend: CloudKit asks nothing of you
operationally; legation's **backend contract** asks for transactional
mutator execution and subset evaluation on your server.

Partial sync is the other split. CloudKit mirrors the whole (per-user)
model graph; Firestore syncs what you query, per query. legation makes the
synced subset an explicit contract: **subscriptions** ((collection,
**predicate**, order, limit/cursor)) with mandatory server-side **auth
filters** and CVR-diffed patches — designed for shared, multi-user data
where "the user's own object graph" is not the natural sync boundary.

## Platform reality

Where each actually runs:

- **SwiftData**: Apple platforms only. **Room**: Android/JVM (+ Kotlin
  Multiplatform). Neither touches the web.
- **legation**: the web (browsers, service workers, Node) — the inverse
  hole. For native apps the protocol is language-agnostic and deliberately
  small (push/pull/poke over schema-defined messages), and ADR-0017 exports
  it as OpenAPI/AsyncAPI for bespoke clients; ADR-0012/0013 remain as
  design documents for how the client model maps to Swift and Kotlin
  idioms, but the maintained implementations are TypeScript-only.

So the honest architecture for a product spanning web + native today is:
legation for the web app, and on native either the platform default (accept
LWW) or a bespoke protocol client (get intent-based sync, pay the
implementation).

## When to choose which

Choose **SwiftData + CloudKit** for Apple-only, per-user data where "the
user's stuff, on the user's devices, merged last-writer-wins" is the whole
requirement — nothing beats its effort-to-value.

Choose **Room** (+ Firestore or your own API) as the Android baseline;
it is the local store, not the sync answer — budget for whichever sync
model you attach.

Choose **legation** when the product is on the web, the data is shared and
permissioned rather than purely per-user, writes need server-side
validation with the possibility of rejection, and you want the
SwiftData-style read model (typed local store, live queries) with an
intent-based sync protocol over a backend you own.
