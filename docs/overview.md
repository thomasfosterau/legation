# Overview

How legation fits together, a runnable in-process example, and the example apps. Terms are defined in [CONTEXT.md](../CONTEXT.md); decisions are in [adr/](adr/).

## Architecture

```
        tab (UI)                    service worker host            your backend
┌──────────────────────┐      ┌──────────────────────────┐      ┌──────────────────┐
│ in-memory mirror     │      │ ClientEngine             │      │ named mutators   │
│ live queries         │◀────▶│  journal (pending        │ push │ (authoritative)  │
│ optimistic overlay   │ b'cast│   mutations)            │─────▶│ + your storage   │
├──────────────────────┤      │  ClientStore (IndexedDB) │      ├──────────────────┤
│ plain fetch()        │      │  pull(cookie) → patch    │◀─────│ SyncServer       │
│ GET /jsonapi/…       │◀────▶│  rebase = replay pending │ patch│  auth filters    │
└──────────────────────┘ fetch│ JSON:API façade (covered │      │  CVR diffing     │
                              │  → replica, else network)│      │  invalidation bus│
                              └──────────────────────────┘      │  (sync room /    │
                                       ▲      ▲                 │   Durable Object)│
                              ┌────────┴──────┴────────┐        └──────────────────┘
                              │ Transport (customisable │◀──poke─┘
                              │ seam; RPC default)      │
                              └─────────────────────────┘
```

- **Writes are intents**: named, schema-validated mutators run optimistically on the client and authoritatively on your backend; conflicts resolve by replay (rebase), not merge strategies.
- **Reads are subscriptions**: collection subsets `(collection, predicate, orderBy, limit/cursor)`, narrowed by deny-by-default auth filters; the server tracks per-client view records (CVRs) and ships minimal row patches.
- **Three fronts, one engine**: a tab reads through a `Client` (an owned engine or a mirror over the worker's), or through plain `fetch()` of a JSON:API URL, which the worker's **façade** answers from the replica when an explicit subscription covers it and forwards unchanged otherwise ([ADR-0029](adr/0029-replica-served-jsonapi-facade.md)).
- **Pull is the correctness path**: periodic HTTP-only sync is fully correct; pokes and streaming are latency optimizations.
- **Bring your own backend**: implement two operations (apply mutations transactionally, evaluate a subset); the library owns CVR bookkeeping, diffing, auth, and fan-out.

See [CONTEXT.md](../CONTEXT.md) for the vocabulary and [adr/](adr/) for the decisions. Coming from TanStack Query / SwiftData / SWR / Apollo? [Coming from TanStack Query](comparisons/coming-from-tanstack-query.md) maps their concepts onto this model. Adopting legation in an app that already has a JSON:API, SSR loads and a service worker? [adoption.md](adoption.md) gives the phase order, the two traps to check first, the reads that always stay on the network, and which existing caches to retire or keep.

### Browser topology: service worker vs. elected main-thread host

The diagram above is the **recommended** topology: the engine lives in the
per-origin service-worker singleton, so there's no leader election — the
platform provides the singleton, and closed-tab pending mutations survive in
the service worker's journal ([ADR-0010](adr/0010-service-worker-hosted-client-engine.md)).

Apps that can't run a service worker (some embedded webviews, or a dev
environment where it's inconvenient) run the same host composition on a
tab's main thread instead, with `@thomasfosterau/legation-browser`'s `ElectedHost.run`
electing exactly one tab per browser profile via the Web Locks API
(`navigator.locks`) — held for that tab's whole lifetime, no voluntary
step-down. Every other tab mirrors it over the same `BroadcastChannel`; when
the elected tab closes or crashes, the browser grants the lock to the next
tab, which boots the engine against the SAME durable store (journal, rows,
cookie), resuming the CVR conversation rather than starting over. `run`
hands back one `Client` that keeps working across that promotion (the
underlying view swaps itself) and a `role: Stream<"host" | "mirror">` purely
for observability. Environments without `navigator.locks` get a documented
fallback (this module logs a warning and becomes host immediately — correct
for a single tab only), not a polyfill.

## Quick start (in-process)

The whole pipeline in one process, on the app-facing surface only: a `Server` over the reference in-memory backend, and a `Client` connected to it by a loopback transport. The [examples](../examples) are the full-size versions.

```ts
import { Effect, Schema } from "effect";
import {
  Authorization,
  Client,
  MemoryBackend,
  Mutation,
  Node,
  Server,
  Transport,
  type Query,
} from "@thomasfosterau/legation";

// 1. The shared vocabulary: a one-node graph, a named mutation, a read.
const Todo = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean });
const { id: _id, ...attributes } = Todo.fields;
const nodes = Node.registry([Node.make("todos", { attributes, filterable: { done: ["eq"] } })]);

const setTodo = Mutation.make("todo/set", Todo);
const mutations = Mutation.registry([
  // Runs optimistically on the client, and again on every rebase.
  { mutator: setTodo, local: (todo, writer) => writer.put("todos", todo.id, todo) },
]);

const open = { collection: "todos", where: { done: false } } as const satisfies Query.Read;

const program = Effect.gen(function* () {
  // 2. Server: one per backend. The reference in-memory backend runs the
  //    authoritative handler; read auth is deny-by-default per collection.
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(setTodo, (todo, writer) => writer.put("todos", todo.id, todo)),
    ])
  );
  const server = yield* Server.make({
    backend,
    auth: {
      policy: Authorization.policy(
        { todos: Authorization.allowAll },
        { collections: nodes.collections }
      ),
    },
  });

  // 3. Client: one per thread, here over an in-process loopback transport.
  const clientGroupId = Client.ClientGroupId.make("g1");
  const { client } = yield* Client.make({
    nodes,
    mutations,
    clientGroupId,
    transport: yield* Transport.makeInMemory(server.handler, clientGroupId),
  });
  yield* client.subscribe(open); // pin the read so the replica holds it
  yield* client.mutate("todo/set", { id: "1", title: "ship it", done: false });
  return yield* client.query(open);
});

Effect.runPromise(Effect.scoped(program)).then(console.log);
```

## Examples

Every example is on ADR-0022's vocabulary — a `Node`/`Edge` graph, declarative
`Query.Read`s, `Mutation`s, one `Client` per thread, one `Server` per backend.
Four are **SvelteKit** apps read through the [`@thomasfosterau/legation-svelte`](../packages/svelte)
rune hooks: three client-only demos that run the **real library server
pipeline in the page** (`Server.make` over a `MemoryBackend`) against a durable
`localStorage` client store, and the full-stack deployment, with a real server
process and the engine in a service worker. The fifth, `audience`, is headless:
server, client and façade in one process, proving the authorization chain in
its tests.

| App                     | Example                              | Exercises                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Todo**                | [`todo`](../examples/todo)           | One node: optimistic writes, live views + a live aggregate, undo/redo, durable journal + true offline, poke-driven convergence. The filter is a route param                                                                                                                                                                                                                                                                             |
| **RealWorld** (Conduit) | [`realworld`](../examples/realworld) | Five nodes; author/favourite/follow joins resolved by `include`d edges, server-side write authorization via identity. A route per Conduit screen                                                                                                                                                                                                                                                                                        |
| **Northwind** (admin)   | [`northwind`](../examples/northwind) | Seven nodes; every join is an `include`d edge, read-merge mutations, search/filter/pagination, reactive per-row reads. A route per screen                                                                                                                                                                                                                                                                                               |
| **Commerce**            | [`commerce`](../examples/commerce)   | The full deployment: SSR + hydration with CVR continuation over [`@thomasfosterau/legation-svelte/kit`](../packages/svelte), a service-worker-hosted engine, a real sync server, WebSockets with HTTP fallback, a no-JS baseline, and the JSON:API **façade** (ADR-0029): plain `fetch()` of a catalog URL answered from the worker's replica, proven in a Chromium test that goes offline                                              |
| **Audience** (headless) | [`audience`](../examples/audience)   | effect-auth, effect-jsonapi and legation composed: an effect-auth session resolved by [`@thomasfosterau/legation-auth`](../packages/auth), a `public / followers / private` policy with an owner, a followers named set and a moderator role compiled into every subscription's auth filter, the sign-out reset, and the façade; tests assert on replica contents, including a property test against effect-auth's own per-row decision |

The first three are SvelteKit **SPAs** — the engine, its store, and the demo
backend are browser-only, so they turn SSR off in the root layout and build
through `adapter-static` with a fallback page. `commerce` is the one that
renders on the server. `commerce`, `realworld` and `audience` have tests, run as
part of `vp run test` — including a browser test of the commerce façade that
needs Chromium (`pnpm exec playwright-core install chromium`; it fails, never
skips, without it).
