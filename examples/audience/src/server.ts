/**
 * The audience server, in process: effect-auth's session service over its
 * own in-memory reference stores (`@thomasfosterau/effect-auth/testing`), a
 * legation `Server` over the reference `MemoryBackend`, and the derived
 * JSON:API (`RestHandlers`) served as a web handler — two carriers, one
 * identity resolver, one auth policy, one evaluator.
 *
 * The chain every read runs, on either carrier:
 *
 *   session cookie → `Resolver` (legation-auth: effect-auth `validateSession`,
 *   fail closed) → `SyncContext.identity` (a typed `Principal`) →
 *   `ReadScopes` (effect-auth's policy compiled to a read scope, translated
 *   exactly) → auth filter AND-ed into the subscription → CVR diff → patch.
 *
 * Sign-in is effect-auth's `createSession` (what its HTTP tier runs after a
 * password check); sign-out is `invalidateSession`. The token travels as
 * effect-auth's session cookie, under the name its HTTP tier would set.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  Hooks,
  SessionCookies,
  SessionService,
  SessionStore,
  UserStore,
  type User,
} from "@thomasfosterau/effect-auth";
import {
  memorySessionStore,
  memoryUserStore,
  memoryUserTable,
} from "@thomasfosterau/effect-auth/testing";
import { Middleware } from "@thomasfosterau/effect-jsonapi";
import {
  Authorization,
  type Backend,
  MemoryBackend,
  MutationRejected,
  Server,
  type Mutation,
} from "@thomasfosterau/legation";
import { Principal, Resolver } from "@thomasfosterau/legation-auth";
import { RestHandlers } from "@thomasfosterau/legation-jsonapi";
import { api, NotFound, Post } from "./api.js";
import {
  FOLLOWS,
  follow,
  followId,
  nodes,
  type Post as PostRow,
  putPost,
  unfollow,
} from "./domain.js";
import { authPolicy } from "./policy.js";

// ─── effect-auth, in process ─────────────────────────────────────────────────

const sessionConfig = {
  sessionExpiresIn: {
    activePeriod: 30 * 24 * 60 * 60 * 1000,
    idlePeriod: 14 * 24 * 60 * 60 * 1000,
  },
};

/**
 * effect-auth's `SessionService` over its reference memory stores, holding
 * `users`. (Hand-written glue: effect-auth's testing entry ships the stores,
 * not the service over them.)
 */
export const authLayer = (users: ReadonlyArray<User>): Layer.Layer<SessionService> => {
  const table = memoryUserTable();
  for (const user of users) MutableHashMap.set(table.users, user.id, user);
  return SessionService.layer(sessionConfig).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(UserStore, memoryUserStore(table)),
        Layer.succeed(SessionStore, memorySessionStore()),
        Hooks.Default
      )
    )
  );
};

/** The session cookie's name, as effect-auth's HTTP tier sets it (`__Host-conduit_session`). */
export const sessionCookie = SessionCookies.cookieNames().session;

/** The `cookie` header carrying a session token. */
export const cookieHeader = (token: string): string => `${sessionCookie}=${token}`;

// ─── Authoritative handlers: every write checked against the principal ──────

/** The user a write acts for, or a permanent rejection when it acts for nobody or someone else. */
const requireUser = (
  context: Backend.SyncContext,
  userId: string
): Effect.Effect<void, MutationRejected> =>
  Option.contains(Principal.userId(Principal.fromContext(context)), userId)
    ? Effect.void
    : Effect.fail(new MutationRejected({ reason: "identity mismatch" }));

const handlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(putPost, (post, writer, context) =>
    Effect.gen(function* () {
      yield* requireUser(context, post.ownerId);
      // An edit may not move someone else's post into one's own name.
      const existing = (yield* writer.get("posts", post.id)) as PostRow | undefined;
      if (existing !== undefined) yield* requireUser(context, existing.ownerId);
      yield* writer.put("posts", post.id, post);
    })
  ),
  MemoryBackend.handler(follow, (edge, writer, context) =>
    requireUser(context, edge.followerId).pipe(
      Effect.andThen(writer.put(FOLLOWS, followId(edge), edge))
    )
  ),
  MemoryBackend.handler(unfollow, (edge, writer, context) =>
    requireUser(context, edge.followerId).pipe(Effect.andThen(writer.del(FOLLOWS, followId(edge))))
  ),
]);

// ─── The server ──────────────────────────────────────────────────────────────

/** A signed-in session, as the browser holds it: the user and the token in its cookie. */
export interface Session {
  readonly user: User;
  readonly token: string;
}

export interface AudienceServer {
  /** The sync server: its `handler` is what a client's transport carries. */
  readonly server: Server.Server;
  /** The identity resolver both carriers run. */
  readonly identity: Authorization.IdentityResolver;
  /** The derived JSON:API as a web handler. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Sign a user in: an effect-auth session. */
  readonly signIn: (user: User) => Effect.Effect<Session>;
  /** Sign a session out: effect-auth invalidates it, so its cookie resolves to anonymous. */
  readonly signOut: (session: Session) => Effect.Effect<void>;
  /** Run one write as a session, through the sync server's push path. */
  readonly mutateAs: <Args, Encoded>(
    session: Session,
    mutation: Mutation.Mutator<string, Args, Encoded>,
    args: Args
  ) => Effect.Effect<Server.Receipt>;
}

/**
 * The HTTP carrier's identity seam: the request's credential headers through
 * the same `IdentityResolver` the sync carrier runs. (Hand-written glue:
 * legation-auth gives the sync protocol its resolver, and `RestHandlers`
 * wants this function; nothing builds one from the other.)
 */
const restContext =
  (identity: Authorization.IdentityResolver): RestHandlers.Options["context"] =>
  (request) =>
    identity
      .resolve({
        clientGroupId: "http",
        credentials: Authorization.credentialsFromHeaders(request.headers),
      })
      .pipe(Effect.map((resolved) => ({ clientGroupId: "http", identity: resolved })));

/** The derived `list` / `get` handlers for the api's one group. */
const postsLive = (rest: RestHandlers.RestHandlers) =>
  HttpApiBuilder.group(api, "posts", (handlers) =>
    handlers
      .handle("list", rest.list(Post))
      .handle("get", rest.get(Post, { notFound: () => new NotFound() }))
  );

/** Build the server over fresh state holding `users`; scoped. */
export const makeServer = (users: ReadonlyArray<User>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Resolver.layerSessions().pipe(Layer.provideMerge(authLayer(users)))
    );
    const sessions = Context.get(context, SessionService);
    const identity = Context.get(context, Authorization.IdentityResolver);

    const backend = yield* MemoryBackend.make(handlers);
    const policy = authPolicy(backend);
    const server = yield* Server.make({ backend, auth: { policy, identity } });

    const rest = RestHandlers.make({
      nodes,
      backend,
      policy,
      context: restContext(identity),
      prefix: "/jsonapi",
    });
    const app = HttpApiBuilder.layer(api).pipe(
      Layer.provide(postsLive(rest).pipe(Layer.provide(Middleware.layer))),
      Layer.provide(Middleware.layer),
      Layer.provide(HttpServer.layerServices)
    ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose)
    );

    const mutationIds = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const nextMutationId = (clientId: string) =>
      Ref.modify(mutationIds, (ids) => {
        const next = (ids.get(clientId) ?? 0) + 1;
        return [next, new Map([...ids, [clientId, next]])] as const;
      });

    const audience: AudienceServer = {
      server,
      identity,
      fetch: handler,
      signIn: (user) =>
        sessions.createSession(user.id).pipe(
          Effect.map((session) => ({ user, token: session.id })),
          Effect.orDie
        ),
      signOut: (session) => sessions.invalidateSession(session.token).pipe(Effect.orDie),
      mutateAs: (session, mutation, args) =>
        Effect.gen(function* () {
          const clientId = `server-${session.user.id}`;
          return yield* server.mutate({
            clientGroupId: clientId,
            clientId,
            mutationId: yield* nextMutationId(clientId),
            mutation,
            args,
            credentials: Option.some(
              Authorization.credentialsFromHeaders({ cookie: cookieHeader(session.token) })
            ),
          });
        }).pipe(Effect.orDie),
    };
    return audience;
  });
