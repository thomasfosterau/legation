/**
 * Sync world — RealWorld (Conduit)
 *
 * The whole sync stack wired up in the page — the real library server pipeline
 * in-process (`SyncServer` + `MemoryBackend` + `CvrStore` + `InvalidationBus`),
 * a durable `localStorage` `ClientStore`, and an offline-aware loopback
 * transport. It exposes:
 *
 *   - `runtime`  — a `ManagedRuntime` providing the built `ClientEngine`, for
 *                  the React bindings (`useQuery` / `useMutation`);
 *   - `setIdentity(username)` — the seam that makes the *server* treat this
 *                  client as a given logged-in user. The `IdentityResolver`
 *                  reads a mutable ref, so "logging in" changes the identity the
 *                  backend's ownership checks see, without rebuilding the engine.
 *
 * Read auth is allow-all (Conduit articles/profiles are public). Write auth is
 * plain code in the backend handlers: a mutator that edits a user, article, or
 * comment first checks `context.identity` against the row's owner, and rejects
 * a write that isn't the principal's — exactly Zero's "permissions are just code
 * in the mutator", enforced server-side and impossible for the client to forge.
 */

import { Effect, Fiber, Layer, ManagedRuntime, Schema, SubscriptionRef, Stream } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  BackendError,
  ClientEngine,
  ClientStore,
  Cvr,
  InvalidationBus,
  MemoryBackend,
  Mutator,
  SyncServer,
  Transport,
  TransportError,
  type VersionNotSupportedError,
} from "@legation/effect";
import type { EffectSyncRuntime } from "@legation/react";

import {
  Article,
  type Comment,
  CLIENT_GROUP_ID,
  CLIENT_ID,
  type Favorite,
  type Follow,
  type User,
  addComment,
  allSubsets,
  createArticle,
  deleteArticle,
  deleteComment,
  favoriteArticle,
  favoriteId,
  followId,
  followUser,
  registerUser,
  unfavoriteArticle,
  unfollowUser,
  updateArticle,
  updateUser,
} from "./domain";

/** What `createWorld` resolves to. */
export interface World {
  readonly runtime: EffectSyncRuntime;
  /** Tell the server which user this client is acting as (null = anonymous). */
  readonly setIdentity: (username: string | null) => void;
  /** Flip the loopback transport between online and (failing) offline. */
  readonly setOnline: (online: boolean) => Promise<void>;
  /** Subscribe to connection status; emits now and on every change. */
  readonly subscribeConnection: (
    listener: (status: Transport.ConnectionStatus) => void
  ) => () => void;
}

// ─── Client mutator handlers (optimistic overlay) ────────────────────────────
//
// These re-run on every rebase, so they must be idempotent — every write here
// is a `put`/`del` keyed by id.

const clientMutators = Mutator.registry([
  { mutator: registerUser, local: (a: { username: string; email: string; password: string }, w) =>
      w.put("users", a.username, { ...a, bio: "", image: "" } satisfies User) },
  { mutator: updateUser, local: (a: User, w) => w.put("users", a.username, a) },
  { mutator: createArticle, local: (a: Article, w) => w.put("articles", a.slug, a) },
  { mutator: updateArticle, local: (a: Article, w) => w.put("articles", a.slug, a) },
  { mutator: deleteArticle, local: (a: { slug: string }, w) => w.del("articles", a.slug) },
  { mutator: favoriteArticle, local: (a: { userId: string; articleSlug: string }, w) =>
      w.put("favorites", favoriteId(a.userId, a.articleSlug), {
        id: favoriteId(a.userId, a.articleSlug),
        userId: a.userId,
        articleSlug: a.articleSlug,
      } satisfies Favorite) },
  { mutator: unfavoriteArticle, local: (a: { userId: string; articleSlug: string }, w) =>
      w.del("favorites", favoriteId(a.userId, a.articleSlug)) },
  { mutator: followUser, local: (a: { followerId: string; followeeId: string }, w) =>
      w.put("follows", followId(a.followerId, a.followeeId), {
        id: followId(a.followerId, a.followeeId),
        followerId: a.followerId,
        followeeId: a.followeeId,
      } satisfies Follow) },
  { mutator: unfollowUser, local: (a: { followerId: string; followeeId: string }, w) =>
      w.del("follows", followId(a.followerId, a.followeeId)) },
  { mutator: addComment, local: (a: Comment, w) => w.put("comments", a.id, a) },
  { mutator: deleteComment, local: (a: { id: string }, w) => w.del("comments", a.id) },
]);

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
        : w.put("users", a.username, { ...a, bio: "", image: "" } satisfies User)
    )
  ),
  MemoryBackend.handler(updateUser, (a, w, ctx) =>
    requireIdentity(ctx, a.username).pipe(Effect.andThen(w.put("users", a.username, a)))
  ),
  MemoryBackend.handler(createArticle, (a, w, ctx) =>
    requireIdentity(ctx, a.authorId).pipe(Effect.andThen(w.put("articles", a.slug, a)))
  ),
  MemoryBackend.handler(updateArticle, (a, w, ctx) =>
    requireIdentity(ctx, a.authorId).pipe(Effect.andThen(w.put("articles", a.slug, a)))
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
        w.put("favorites", favoriteId(a.userId, a.articleSlug), {
          id: favoriteId(a.userId, a.articleSlug),
          userId: a.userId,
          articleSlug: a.articleSlug,
        } satisfies Favorite)
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
        w.put("follows", followId(a.followerId, a.followeeId), {
          id: followId(a.followerId, a.followeeId),
          followerId: a.followerId,
          followeeId: a.followeeId,
        } satisfies Follow)
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

// ─── Offline-aware loopback transport ────────────────────────────────────────

const makeOfflineTransport = (
  handler: Transport.ServerHandler,
  online: SubscriptionRef.SubscriptionRef<boolean>
): Transport.ClientTransport => {
  const whenOnline = <A>(
    effect: Effect.Effect<A, TransportError | VersionNotSupportedError>
  ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
    SubscriptionRef.get(online).pipe(
      Effect.flatMap((on) =>
        on ? effect : Effect.fail(new TransportError({ message: "Client is offline" }))
      )
    );
  return {
    push: (request) => whenOnline(handler.handlePush(request)),
    pull: (request) => whenOnline(handler.handlePull(request)),
    pokes: handler.pokes(CLIENT_GROUP_ID),
    status: SubscriptionRef.get(online).pipe(
      Effect.map((on): Transport.ConnectionStatus => (on ? "connected" : "disconnected"))
    ),
    statusChanges: SubscriptionRef.changes(online).pipe(
      Stream.map((on): Transport.ConnectionStatus => (on ? "connected" : "disconnected"))
    ),
  };
};

// ─── Seed data ───────────────────────────────────────────────────────────────

const seed = (backend: Backend.Backend, bus: InvalidationBus.InvalidationBus) =>
  Effect.gen(function* () {
    const now = Date.now();
    const users: ReadonlyArray<User> = [
      { username: "emma", email: "emma@conduit.dev", password: "demo", bio: "Writing about Effect & sync.", image: "https://i.pravatar.cc/120?u=emma" },
      { username: "liang", email: "liang@conduit.dev", password: "demo", bio: "Frontend, offline-first.", image: "https://i.pravatar.cc/120?u=liang" },
    ];
    const articles: ReadonlyArray<Article> = [
      { slug: "welcome-to-conduit", title: "Welcome to Conduit", description: "What this demo shows", body: "This is the RealWorld example driving the **legation** engine.\n\nEverything you do — posting, favoriting, following — is an optimistic mutator that syncs to an in-page backend and rebases.", tagList: ["intro", "effect"], authorId: "emma", createdAt: now, updatedAt: now },
      { slug: "offline-first-writes", title: "Offline-first writes", description: "Queue writes, then converge", body: "Go offline and keep posting. Your mutations pile up in the durable journal and flush on reconnect.", tagList: ["sync", "offline"], authorId: "liang", createdAt: now + 1, updatedAt: now + 1 },
    ];
    let seq = 0;
    const applyAs = (clientId: string, mutator: string, args: unknown) =>
      Effect.gen(function* () {
        seq += 1;
        const result = yield* backend.applyMutations(
          { clientGroupId: "seed", identity: clientId },
          [{ clientId: "seed", mutationId: seq, mutator, args, createdAt: Date.now() }]
        );
        yield* bus.publish(result.hints);
      });
    for (const user of users) {
      yield* applyAs(user.username, "user/register", { username: user.username, email: user.email, password: user.password });
    }
    for (const article of articles) {
      yield* applyAs(article.authorId, "article/create", Schema.encodeSync(Article)(article));
    }
  });

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export const createWorld = (): Promise<World> =>
  new Promise<World>((resolve, reject) => {
    // The server's view of "who is this client" — mutated by setIdentity.
    let currentIdentity: string | null = null;

    const program = Effect.gen(function* () {
      const online = yield* SubscriptionRef.make(true);

      const backend = yield* MemoryBackend.make(backendHandlers);
      const cvr = yield* Cvr.makeMemoryStore;
      const bus = yield* InvalidationBus.makeInProcess;
      const identityResolver: Authorization.IdentityResolver = {
        resolve: () => Effect.succeed(currentIdentity ?? undefined),
      };
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, authPolicy),
        Effect.provideService(Authorization.IdentityResolver, identityResolver),
        Effect.provideService(Cvr.CvrStore, cvr),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      yield* seed(backend, bus);

      const transport = makeOfflineTransport(handler, online);
      const store = yield* ClientStore.makeKeyValue({ prefix: "react-realworld/" }).pipe(
        Effect.provide(BrowserKeyValueStore.layerLocalStorage)
      );
      const engine = yield* ClientEngine.make({
        clientId: CLIENT_ID,
        clientGroupId: CLIENT_GROUP_ID,
        mutators: clientMutators,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );

      for (const subset of allSubsets) yield* engine.subscribe(subset);
      yield* engine.runSync;

      const runtime: EffectSyncRuntime = ManagedRuntime.make(
        Layer.succeed(ClientEngine.ClientEngine, engine)
      );

      const world: World = {
        runtime,
        setIdentity: (username) => {
          currentIdentity = username;
        },
        setOnline: (next) => Effect.runPromise(SubscriptionRef.set(online, next)),
        subscribeConnection: (listener) => {
          const fiber = Effect.runFork(
            Stream.runForEach(transport.statusChanges, (status) =>
              Effect.sync(() => listener(status))
            )
          );
          void Effect.runPromise(transport.status).then(listener);
          return () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        },
      };

      yield* Effect.sync(() => resolve(world));
      yield* Effect.never;
    });

    Effect.runFork(
      Effect.scoped(program).pipe(
        Effect.catchCause((cause) => Effect.sync(() => reject(new Error(String(cause)))))
      )
    );
  });
