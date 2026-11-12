/**
 * A device: one browser profile, as the client side of the app sees it — a
 * durable replica (a `ClientStore` over a `KeyValueStore` that outlives any
 * one Client), a cookie jar holding the effect-auth session cookie, a
 * network that can go down, and the one `Client` over them.
 *
 * The cookie jar is read the way effect-auth's client session store is, and
 * legation-auth's `SignOut.follow` keeps the replica on it: each change of the
 * jar adopts the session's identity fingerprint with `Client.reset` (#212): a sign-out or an account switch drops the replica's confirmed
 * rows and quarantines the superseded user's unpushed writes before the next
 * viewer can read anything.
 *
 * The façade (`JsonApiFacade`) is the third front over the same replica: a
 * plain `fetch()` of a JSON:API URL answered locally when a subscription
 * covers it, under the same declarations the server's derived handlers use.
 */
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import {
  Authorization,
  Client,
  ClientStore,
  Identity,
  type Query,
  Transport,
} from "@thomasfosterau/legation";
import type { ClientEngine } from "@thomasfosterau/legation/internal";
import { SignOut } from "@thomasfosterau/legation-auth/client";
import { JsonApiFacade } from "@thomasfosterau/legation-jsonapi";
import { api, resources } from "./api.js";
import { mutations, nodes, type Post } from "./domain.js";
import { type AudienceServer, cookieHeader, type Session } from "./server.js";

export interface Device {
  /** The Client over this device's durable replica. */
  readonly client: Client.Client;
  /** The engine the Client owns: the tests push and pull explicitly. */
  readonly engine: ClientEngine.ClientEngine;
  /** The durable replica itself, for reading what is stored rather than what a query answers. */
  readonly store: ClientStore.ClientStore;
  /** The JSON:API façade over the replica. */
  readonly facade: JsonApiFacade.FetchHandler;
  /** Sign a session in on this device: its cookie goes in the jar, the replica adopts its identity. */
  readonly signIn: (session: Session) => Effect.Effect<SignOut.SessionChange>;
  /** Sign the current session out: effect-auth invalidates it, the jar empties, the replica resets. */
  readonly signOut: Effect.Effect<SignOut.SessionChange>;
  /** Take the network down (or bring it back): every push, pull and read fails while it is down. */
  readonly setOnline: (online: boolean) => Effect.Effect<void>;
  /** Run a read of the posts against the replica: the posts it answers. */
  readonly posts: (
    read: Query.Read & { readonly collection: "posts" }
  ) => Effect.Effect<ReadonlyArray<Post>>;
  /** Every post the durable store holds, whatever any query would answer. */
  readonly stored: Effect.Effect<ReadonlyArray<Post>>;
}

/**
 * The browser's cookie jar, holding at most one session, read the way
 * effect-auth's session Atom (`makeSessionAtoms(...).state`, through
 * `SignOut.sessionStoreOf`) is read: `SignOut.follow` subscribes to it exactly
 * as it would to that store. (Hand-written glue: the example has no auth HTTP
 * tier for `createAuthClient` to talk to, so the jar stands in for its store.)
 */
interface CookieJar {
  readonly store: SignOut.SessionStore;
  readonly current: Effect.Effect<Option.Option<Session>>;
  readonly set: (session: Option.Option<Session>) => Effect.Effect<void>;
}

const makeJar = (): CookieJar => {
  const session = MutableRef.make(Option.none<Session>());
  const listeners = new Set<() => void>();
  return {
    store: {
      get: () => ({ data: Option.getOrNull(MutableRef.get(session)), isPending: false }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    current: Effect.sync(() => MutableRef.get(session)),
    set: (next) =>
      Effect.sync(() => {
        MutableRef.set(session, next);
        listeners.forEach((listener) => listener());
      }),
  };
};

/**
 * A device with a fresh profile, signed out; scoped. `name` keys its client
 * group and client id, which stay the same across the sessions it hosts, as
 * a browser profile's do.
 */
export const makeDevice = (audience: AudienceServer, name: string) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore.pipe(Effect.provide(KeyValueStore.layerMemory));
    const store = yield* ClientStore.makeKeyValue().pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, kv)
    );
    const jar = makeJar();
    const clientGroupId = `group-${name}`;
    // The in-process sync server, presenting whatever session cookie the jar
    // holds on each call, as a browser's cookie jar does.
    const transport = yield* Transport.makeInMemory(audience.server.handler, clientGroupId, {
      credentials: Effect.map(
        jar.current,
        Option.map(({ token }) =>
          Authorization.credentialsFromHeaders({ cookie: cookieHeader(token) })
        )
      ),
    });
    // What the façade reads as `navigator.onLine`; the transport fails calls by itself.
    const online = MutableRef.make(true);
    const { client, engine } = yield* Client.make({
      nodes,
      mutations,
      clientId: `client-${name}`,
      clientGroupId,
      store,
      transport,
      // The tests drive push and pull, so every replica they read is settled.
      sync: false,
      // A fresh profile boots signed out (`SignOut.fingerprintOfSession(None)`).
      identity: Identity.anonymous,
    });
    // Every change of the jar resets the replica as needed, for the device's life.
    const following = yield* SignOut.follow(client, jar.store);
    const change = (next: Option.Option<Session>) =>
      jar
        .set(next)
        .pipe(Effect.andThen(following.settled), Effect.flatMap(Effect.fromOption), Effect.orDie);

    const facade = JsonApiFacade.fetchHandler({
      nodes,
      api,
      resources,
      view: client.view,
      coverageOf: client.coverageOf,
      totalOf: (subset) => Effect.map(client.totalOf(subset), Option.fromUndefinedOr),
      cookie: Effect.map(store.getCookie, Option.fromUndefinedOr),
      online: () => MutableRef.get(online),
    });

    const device: Device = {
      client,
      engine,
      store,
      facade,
      signIn: (session) => change(Option.some(session)),
      signOut: Effect.gen(function* () {
        const current = yield* jar.current;
        if (Option.isSome(current)) yield* audience.signOut(current.value);
        return yield* change(Option.none());
      }),
      setOnline: (next) =>
        Effect.sync(() => MutableRef.set(online, next)).pipe(
          Effect.andThen(transport.setOnline(next))
        ),
      posts: (read) =>
        client.query(read).pipe(
          Effect.map((rows) => rows.map((row) => row.value)),
          Effect.orDie
        ),
      stored: store.listRows("posts").pipe(
        Effect.map((rows) => rows.map((row) => row.value as Post)),
        Effect.orDie
      ),
    };
    return device;
  });
