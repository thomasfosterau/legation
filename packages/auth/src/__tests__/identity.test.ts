/**
 * The identity resolver over an in-process effect-auth (#219 §1): a session
 * cookie, a session bearer token and an API key each resolve to a typed
 * principal on `SyncContext.identity`, re-validated on every resolve, and
 * every failure — an unknown, revoked or disabled credential, a store fault, a
 * defect — fails closed to anonymous without failing the request.
 */
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { ApiKeyService, SessionCookies, SessionService } from "@thomasfosterau/effect-auth";
import {
  Authorization,
  Backend,
  MemoryBackend,
  Mutator,
  Predicate,
} from "@thomasfosterau/legation";
import { Cvr, InvalidationBus, Subset, SyncServer } from "@thomasfosterau/legation/internal";
import { Principal, Resolver } from "@thomasfosterau/legation-auth";
import { alice, authLayer, bob } from "./harness.js";
import { asPrincipal, Crash, mentions } from "./support.js";
import { withLayer } from "./with-layer.js";

const cookieName = SessionCookies.cookieNames().session;

const withCookie = (token: string) =>
  Authorization.credentialsFromHeaders({ cookie: `theme=dark; ${cookieName}=${token}` });
const withBearer = (token: string) =>
  Authorization.credentialsFromHeaders({ authorization: `Bearer ${token}` });
const withApiKey = (key: string, extra: Record<string, string> = {}) =>
  Authorization.credentialsFromHeaders({ "x-api-key": key, ...extra });

/** Resolve one request's credentials with the resolver over both planes. */
const resolveWith = (credentials: Authorization.RequestCredentials) =>
  Effect.gen(function* () {
    const resolver = yield* Authorization.IdentityResolver;
    return yield* resolver.resolve({ clientGroupId: "group-1", credentials });
  });

/** Credentials whose header lookup throws: a defect in reading the request itself. */
const exploding: Authorization.RequestCredentials = {
  header: () => {
    throw new Crash({ message: "header lookup crashed" });
  },
};

const resolverLayer = (modes?: Parameters<typeof authLayer>[0]) =>
  Resolver.layer().pipe(Layer.provideMerge(authLayer(modes)));

layer(resolverLayer(), { buildPerTest: true })("Resolver: the session plane", (it) => {
  it.effect("resolves a session cookie to a typed Session principal", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const session = yield* sessions.createSession(alice.id, { activeOrganizationId: "org-1" });
      const principal = yield* resolveWith(withCookie(session.id));
      expect(P.isTagged(principal, "Session")).toBe(true);
      const typed = asPrincipal(principal);
      expect(Principal.userId(typed)).toEqual(Option.some(alice.id));
      expect(typed).toMatchObject({
        _tag: "Session",
        userId: alice.id,
        user: { id: alice.id, name: "Alice" },
        sessionAttributes: { activeOrganizationId: "org-1" },
      });
      // The principal carries no credential: effect-auth reports a validated
      // session's id as the raw token, and it is left out.
      expect(mentions(principal, session.id)).toBe(false);
    })
  );

  it.effect("resolves an Authorization: Bearer session token", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const session = yield* sessions.createSession(bob.id);
      const principal = asPrincipal(yield* resolveWith(withBearer(session.id)));
      expect(Principal.userId(principal)).toEqual(Option.some(bob.id));
    })
  );

  it.effect("reads the cookie under the naming the app configures", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const session = yield* sessions.createSession(alice.id);
      const naming = { name: "app_session", secure: false };
      const resolver = Resolver.make(
        { sessions: Option.some(sessions), apiKeys: Option.none() },
        { cookie: naming }
      );
      const named = SessionCookies.cookieNames(naming).session;
      expect(named).toBe("app_session");
      const credentials = Authorization.credentialsFromHeaders({
        cookie: `${named}=${session.id}`,
      });
      const principal = yield* resolver.resolve({ clientGroupId: "g", credentials });
      expect(P.isTagged(principal, "Session")).toBe(true);
      // The default name is not read under another naming.
      const other = yield* resolver.resolve({
        clientGroupId: "g",
        credentials: withCookie(session.id),
      });
      expect(other).toEqual(Principal.anonymous);
    }).pipe(withLayer(authLayer()))
  );

  it.effect("re-validates on every resolve: a revoked session is anonymous on the next one", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const session = yield* sessions.createSession(alice.id);
      expect(P.isTagged(yield* resolveWith(withCookie(session.id)), "Session")).toBe(true);
      yield* sessions.invalidateSession(session.id);
      expect(yield* resolveWith(withCookie(session.id))).toEqual(Principal.anonymous);
    })
  );

  it.effect("fails closed to anonymous on an unknown cookie", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith(withCookie("not-a-session"))).toEqual(Principal.anonymous);
    })
  );

  it.effect("is anonymous for a request with no credential", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith(Authorization.noCredentials)).toEqual(Principal.anonymous);
    })
  );

  it.effect("fails closed to anonymous on a session-store fault", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith(withCookie("any-token"))).toEqual(Principal.anonymous);
    }).pipe(withLayer(resolverLayer({ sessions: "fault" })))
  );

  it.effect("fails closed to anonymous on a session-store defect", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith(withCookie("any-token"))).toEqual(Principal.anonymous);
    }).pipe(withLayer(resolverLayer({ sessions: "defect" })))
  );

  it.effect("fails closed to anonymous when reading the request itself dies", () =>
    Effect.gen(function* () {
      const resolver = Resolver.make({ sessions: Option.none(), apiKeys: Option.none() });
      const principal = yield* resolver.resolve({ clientGroupId: "g", credentials: exploding });
      expect(principal).toEqual(Principal.anonymous);
    })
  );
});

layer(resolverLayer(), { buildPerTest: true })("Resolver: the API key plane", (it) => {
  it.effect("resolves an API key to a typed ApiKey principal, without the key", () =>
    Effect.gen(function* () {
      const apiKeys = yield* ApiKeyService;
      const created = yield* apiKeys.create(alice.id, {
        name: "ci",
        permissions: { posts: ["read"] },
      });
      const principal = yield* resolveWith(withApiKey(created.key));
      expect(principal).toEqual({
        _tag: "ApiKey",
        userId: alice.id,
        keyId: created.apiKey.id,
        permissions: Option.some({ posts: ["read"] }),
      });
      expect(mentions(principal, created.key)).toBe(false);
      expect(mentions(principal, created.apiKey.keyHash)).toBe(false);
    })
  );

  it.effect("fails closed to anonymous on a revoked (deleted) key", () =>
    Effect.gen(function* () {
      const apiKeys = yield* ApiKeyService;
      const created = yield* apiKeys.create(alice.id);
      expect(P.isTagged(yield* resolveWith(withApiKey(created.key)), "ApiKey")).toBe(true);
      yield* apiKeys.delete(alice.id, created.apiKey.id);
      expect(yield* resolveWith(withApiKey(created.key))).toEqual(Principal.anonymous);
    })
  );

  it.effect("fails closed to anonymous on a disabled key", () =>
    Effect.gen(function* () {
      const apiKeys = yield* ApiKeyService;
      const created = yield* apiKeys.create(bob.id);
      yield* apiKeys.update(bob.id, created.apiKey.id, { enabled: false });
      expect(yield* resolveWith(withApiKey(created.key))).toEqual(Principal.anonymous);
    })
  );

  it.effect("a key that does not verify is anonymous even beside a valid session cookie", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const session = yield* sessions.createSession(alice.id);
      const principal = yield* resolveWith(
        withApiKey("ak_forged", { cookie: `${cookieName}=${session.id}` })
      );
      expect(principal).toEqual(Principal.anonymous);
    })
  );

  it.effect("fails closed to anonymous on an API-key-store fault and defect", () =>
    Effect.gen(function* () {
      const fault = yield* resolveWith(withApiKey("ak_any")).pipe(
        withLayer(resolverLayer({ apiKeys: "fault" }))
      );
      const defect = yield* resolveWith(withApiKey("ak_any")).pipe(
        withLayer(resolverLayer({ apiKeys: "defect" }))
      );
      expect(fault).toEqual(Principal.anonymous);
      expect(defect).toEqual(Principal.anonymous);
    })
  );

  it.effect("a resolver built without the API key plane resolves a key to anonymous", () =>
    Effect.gen(function* () {
      const apiKeys = yield* ApiKeyService;
      const created = yield* apiKeys.create(alice.id);
      const principal = yield* resolveWith(withApiKey(created.key)).pipe(
        withLayer(Resolver.layerSessions())
      );
      expect(principal).toEqual(Principal.anonymous);
    }).pipe(withLayer(authLayer()))
  );
});

layer(resolverLayer(), { buildPerTest: true })("Resolver: logging", (it) => {
  it.effect("logs a fail-closed resolution by plane and kind, never the credential", () =>
    Effect.gen(function* () {
      const logged: Array<unknown> = [];
      const recorder = Logger.layer([
        Logger.make((options) => {
          logged.push({
            message: options.message,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations),
          });
        }),
      ]);
      const token = "sekrit-session-token-123";
      const key = "ak_sekrit-api-key-456";
      yield* resolveWith(withCookie(token)).pipe(withLayer(recorder));
      yield* resolveWith(withApiKey(key)).pipe(withLayer(recorder));
      expect(logged).toHaveLength(2);
      expect(mentions(logged, "failed closed to anonymous")).toBe(true);
      expect(mentions(logged, "rejected")).toBe(true);
      expect(mentions(logged, token)).toBe(false);
      expect(mentions(logged, key)).toBe(false);
    })
  );
});

// ─── End to end through the sync server ──────────────────────────────────────

const PutArgs = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
});
const putPost = Mutator.make("post/put", PutArgs);

/** Each principal reads its own posts; anonymous reads none. */
const ownPosts: Authorization.AuthFilter = (context) =>
  Effect.succeed(
    Option.match(Principal.userId(Principal.fromContext(context)), {
      onNone: () => Authorization.Deny,
      onSome: (user) => Authorization.filter(Predicate.eq("ownerId", user)),
    })
  );

layer(resolverLayer(), { buildPerTest: true })("Resolver behind SyncServer", (it) => {
  it.effect("puts the verified principal on SyncContext.identity for a pull", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(putPost, (args, writer) => writer.put("posts", args.id, args)),
        ])
      );
      const recording: Authorization.AuthFilter = (context) =>
        Ref.update(seen, (all) => [...all, context.identity]).pipe(
          Effect.andThen(ownPosts(context))
        );
      const server = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, Authorization.policy({ posts: recording })),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(
          InvalidationBus.InvalidationBus,
          yield* InvalidationBus.makeInProcess
        ),
        Effect.provideService(Authorization.IdentityResolver, yield* Authorization.IdentityResolver)
      );
      yield* server.handlePush({
        clientGroupId: "writer",
        mutations: [
          {
            clientId: "w",
            mutationId: 1,
            mutator: "post/put",
            args: { id: "a1", ownerId: alice.id },
            createdAt: 0,
          },
          {
            clientId: "w",
            mutationId: 2,
            mutator: "post/put",
            args: { id: "b1", ownerId: bob.id },
            createdAt: 0,
          },
        ],
      });
      const sessions = yield* SessionService;
      const session = yield* sessions.createSession(alice.id);
      const pull = (credentials: Authorization.RequestCredentials) =>
        server.handlePull(
          { clientGroupId: "group-1", subscriptions: [Subset.make({ collection: "posts" })] },
          { credentials: Option.some(credentials) }
        );
      const signedIn = yield* pull(withCookie(session.id));
      expect(signedIn.patch.flatMap((op) => (P.isTagged(op, "Put") ? [op.id] : []))).toEqual([
        "a1",
      ]);
      const forged = yield* pull(withCookie("forged"));
      expect(forged.patch.flatMap((op) => (P.isTagged(op, "Put") ? [op.id] : []))).toEqual([]);
      const identities = yield* Ref.get(seen);
      expect(identities.map((identity) => asPrincipal(identity)._tag)).toEqual([
        "Session",
        "Anonymous",
      ]);
    })
  );
});
