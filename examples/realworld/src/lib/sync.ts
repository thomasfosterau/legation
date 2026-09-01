/**
 * Sync world — RealWorld (Conduit)
 *
 * The whole sync stack wired up in the page: `Server` (the one server-side
 * object — protocol handler plus `broadcast`, with in-memory CVR storage and an
 * in-process fan-out bus by default) over a `MemoryBackend`, reached through a
 * loopback transport behind a simulated-offline gate, with a durable
 * `localStorage` client store.
 *
 * The client is `Client.make` — the zero-wiring entry point. It resolves its
 * store and transport from **context**, so both are supplied as layers here and
 * the Client itself takes no wiring beyond the graph and the mutations; it also
 * starts the sync loop, so the class of bug where an app forgets `runSync`
 * cannot happen. A `ManagedRuntime` owns the whole layer's scope, which is what
 * keeps the loop and the server's fan-out alive for the app's lifetime.
 *
 * `setIdentity(username)` is the seam that makes the *server* treat this client
 * as a given logged-in user: the `IdentityResolver` reads a mutable ref, so
 * "logging in" changes the identity the backend's ownership checks see without
 * rebuilding anything.
 *
 * Read auth is allow-all (Conduit articles/profiles are public). Write auth is
 * plain code in the backend handlers: a mutation that edits a user, article, or
 * comment first checks `context.identity` against the row's owner, and rejects
 * a write that isn't the principal's — enforced server-side and impossible for
 * the client to forge.
 */

import { Context, Effect, Layer, ManagedRuntime, Ref, Schema, Stream } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  BackendError,
  Client,
  ClientStore,
  MemoryBackend,
  Server,
  Transport,
} from "@legation/effect";
import type { Runtime } from "@legation/svelte";

import {
  type Article,
  ArticleInput,
  CLIENT_GROUP_ID,
  CLIENT_ID,
  type Comment,
  addComment,
  articleRow,
  createArticle,
  deleteArticle,
  deleteComment,
  favoriteArticle,
  favoriteId,
  favoriteRow,
  followId,
  followRow,
  followUser,
  mutations,
  nodes,
  registerUser,
  shellReads,
  unfavoriteArticle,
  unfollowUser,
  updateArticle,
  updateUser,
  userRow,
} from "./domain";

/** What `createWorld` resolves to. */
export interface World {
  readonly runtime: Runtime.ClientRuntime;
  /** Tell the server which user this client is acting as (null = anonymous). */
  readonly setIdentity: (username: string | null) => void;
  /** Flip the loopback transport between online and (failing) offline. */
  readonly setOnline: (online: boolean) => Promise<void>;
  /** Connection status: the current value now, then every change. */
  readonly connection: Stream.Stream<Transport.ConnectionStatus>;
}

// ─── Backend handlers (authoritative, with ownership checks) ─────────────────

/** Reject a write unless `context.identity` matches the expected owner. */
const requireIdentity = (
  context: { readonly identity?: unknown },
  owner: string
): Effect.Effect<void, BackendError> =>
  context.identity === owner
    ? Effect.void
    : Effect.fail(
        new BackendError({
          message: `Not authorised: identity "${String(context.identity)}" may not write as "${owner}"`,
        })
      );

const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(registerUser, (a, w) =>
    Effect.flatMap(w.get("users", a.username), (existing) =>
      existing !== undefined
        ? Effect.fail(new BackendError({ message: `Username "${a.username}" is taken` }))
        : w.put("users", a.username, userRow(a))
    )
  ),
  MemoryBackend.handler(updateUser, (a, w, ctx) =>
    requireIdentity(ctx, a.username).pipe(Effect.andThen(w.put("users", a.username, userRow(a))))
  ),
  MemoryBackend.handler(createArticle, (a, w, ctx) =>
    requireIdentity(ctx, a.authorId).pipe(
      Effect.andThen(w.put("articles", a.slug, articleRow(a)))
    )
  ),
  MemoryBackend.handler(updateArticle, (a, w, ctx) =>
    requireIdentity(ctx, a.authorId).pipe(
      Effect.andThen(w.put("articles", a.slug, articleRow(a)))
    )
  ),
  MemoryBackend.handler(deleteArticle, (a, w, ctx) =>
    // Only the author may delete; look the row up to find the owner.
    Effect.flatMap(w.get("articles", a.slug), (row) => {
      const owner = (row as Article | undefined)?.authorId;
      if (owner === undefined) return Effect.void; // already gone
      return requireIdentity(ctx, owner).pipe(Effect.andThen(w.del("articles", a.slug)));
    })
  ),
  MemoryBackend.handler(favoriteArticle, (a, w, ctx) =>
    requireIdentity(ctx, a.userId).pipe(
      Effect.andThen(
        w.put("favorites", favoriteId(a.userId, a.articleSlug), favoriteRow(a.userId, a.articleSlug))
      )
    )
  ),
  MemoryBackend.handler(unfavoriteArticle, (a, w, ctx) =>
    requireIdentity(ctx, a.userId).pipe(
      Effect.andThen(w.del("favorites", favoriteId(a.userId, a.articleSlug)))
    )
  ),
  MemoryBackend.handler(followUser, (a, w, ctx) =>
    requireIdentity(ctx, a.followerId).pipe(
      Effect.andThen(
        w.put(
          "follows",
          followId(a.followerId, a.followeeId),
          followRow(a.followerId, a.followeeId)
        )
      )
    )
  ),
  MemoryBackend.handler(unfollowUser, (a, w, ctx) =>
    requireIdentity(ctx, a.followerId).pipe(
      Effect.andThen(w.del("follows", followId(a.followerId, a.followeeId)))
    )
  ),
  MemoryBackend.handler(addComment, (a, w, ctx) =>
    requireIdentity(ctx, a.authorId).pipe(Effect.andThen(w.put("comments", a.id, a)))
  ),
  MemoryBackend.handler(deleteComment, (a, w, ctx) =>
    Effect.flatMap(w.get("comments", a.id), (row) => {
      const owner = (row as Comment | undefined)?.authorId;
      if (owner === undefined) return Effect.void;
      return requireIdentity(ctx, owner).pipe(Effect.andThen(w.del("comments", a.id)));
    })
  ),
]);

/** Reads are public: every collection is allow-all. */
const authPolicy = Authorization.policy({
  users: Authorization.allowAll,
  articles: Authorization.allowAll,
  comments: Authorization.allowAll,
  favorites: Authorization.allowAll,
  follows: Authorization.allowAll,
});

// ─── Seed data ───────────────────────────────────────────────────────────────

const seed = (backend: Backend.Backend): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = Date.now();
    const people = [
      { username: "emma", email: "emma@conduit.dev", password: "demo" },
      { username: "liang", email: "liang@conduit.dev", password: "demo" },
    ];
    const posts: ReadonlyArray<ArticleInput> = [
      { slug: "welcome-to-conduit", title: "Welcome to Conduit", description: "What this demo shows", body: "This is the RealWorld example driving the **legation** engine.\n\nEverything you do — posting, favoriting, following — is an optimistic mutation that syncs to an in-page backend and rebases.", tagList: ["intro", "effect"], authorId: "emma", createdAt: now, updatedAt: now },
      { slug: "offline-first-writes", title: "Offline-first writes", description: "Queue writes, then converge", body: "Go offline and keep posting. Your mutations pile up in the durable journal and flush on reconnect.", tagList: ["sync", "offline"], authorId: "liang", createdAt: now + 1, updatedAt: now + 1 },
    ];
    let seq = 0;
    const applyAs = (identity: string, mutator: string, args: unknown) =>
      Effect.gen(function* () {
        seq += 1;
        yield* backend.applyMutations({ clientGroupId: "seed", identity }, [
          { clientId: "seed", mutationId: seq, mutator, args, createdAt: Date.now() },
        ]);
      });
    for (const person of people) yield* applyAs(person.username, "user/register", person);
    for (const post of posts)
      yield* applyAs(post.authorId, "article/create", Schema.encodeSync(ArticleInput)(post));
  }).pipe(Effect.orDie);

// ─── The rig: the demo server and the knobs the shell drives ─────────────────

interface Rig {
  /** The loopback transport, behind the simulated-offline gate. */
  readonly transport: Transport.ClientTransport;
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  readonly setIdentity: (username: string | null) => Effect.Effect<void>;
  readonly connection: Stream.Stream<Transport.ConnectionStatus>;
}
const Rig = Context.Service<Rig>("realworld/Rig");

const rigLayer = Layer.effect(Rig)(
  Effect.gen(function* () {
    // The server's view of "who is this client" — the resolver reads it on
    // every request, so login/logout takes effect without a rebuild.
    const identity = yield* Ref.make<string | undefined>(undefined);
    const backend = yield* MemoryBackend.make(backendHandlers);
    const server = yield* Server.make({
      backend,
      auth: { policy: authPolicy, identity: { resolve: () => Ref.get(identity) } },
    });
    yield* seed(backend);

    const loopback = yield* Transport.makeInMemory(server.handler, CLIENT_GROUP_ID);
    const { transport, setOffline } = yield* Transport.simulateOffline(loopback);

    return {
      transport,
      setOffline,
      setIdentity: (username) => Ref.set(identity, username ?? undefined),
      connection: Stream.concat(Stream.fromEffect(transport.status), transport.statusChanges),
    };
  })
);

// ─── The app layer ───────────────────────────────────────────────────────────
//
// `Client.make` resolves its store and transport from context — options win
// over context, context over defaults — so the two seams are supplied as
// layers and the Client call itself stays declarative.

const storeLayer = Layer.effect(ClientStore.ClientStore)(
  ClientStore.makeKeyValue({ prefix: "realworld/" }).pipe(
    Effect.provide(BrowserKeyValueStore.layerLocalStorage)
  )
);

const transportLayer = Layer.effect(Transport.ClientTransport)(
  Effect.map(Rig, (rig) => rig.transport)
);

const appLayer = Layer.effect(Client.Client)(
  Effect.gen(function* () {
    const client = yield* Client.make({
      nodes,
      mutations,
      clientId: CLIENT_ID,
      clientGroupId: CLIENT_GROUP_ID,
      // Both legs are opt-in: without `pushDebounce` a journaled mutation
      // waits for a reconnect, a poke, or an explicit push, so an online
      // client would sit on unflushed writes. `pullInterval` is the
      // correctness backstop for when no poke arrives.
      syncLoop: { pushDebounce: "300 millis", pullInterval: "15 seconds" },
    });
    // Pin the working set for the tab's lifetime: the feed filters are set
    // operations over whole join collections, and an `include` only resolves
    // against rows this client has synced.
    yield* Effect.forEach(shellReads, (read) => client.subscribe(read), { discard: true }).pipe(
      Effect.orDie
    );
    return client;
  })
).pipe(Layer.provide(storeLayer), Layer.provide(transportLayer), Layer.provideMerge(rigLayer));

/** Build the world. The `ManagedRuntime` owns the scope for the app's life. */
export const createWorld = async (): Promise<World> => {
  const runtime = ManagedRuntime.make(appLayer);
  const rig = await runtime.runPromise(Rig);
  return {
    runtime,
    setIdentity: (username) => void runtime.runPromise(rig.setIdentity(username)),
    setOnline: (next) => runtime.runPromise(rig.setOffline(!next)),
    connection: rig.connection,
  };
};
