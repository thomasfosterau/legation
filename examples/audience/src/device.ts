/**
 * A device: one browser profile, as the client side of the app sees it — a
 * durable replica (a `ClientStore` over a `KeyValueStore` that outlives any
 * one Client), a cookie jar holding the effect-auth session cookie, a
 * network that can go down, and the one `Client` over them.
 *
 * Signing in or out goes through legation-auth's `SignOut.onSessionChange`,
 * which adopts the session's identity fingerprint with `Client.reset`
 * (#212): a sign-out or an account switch drops the replica's confirmed
 * rows and quarantines the superseded user's unpushed writes before the next
 * viewer can read anything.
 *
 * The façade (`JsonApiFacade`) is the third front over the same replica: a
 * plain `fetch()` of a JSON:API URL answered locally when a subscription
 * covers it, under the same declarations the server's derived handlers use.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Digest from "effect/crypto/Digest";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import {
  Authorization,
  Client,
  ClientStore,
  Identity,
  type Query,
  Transport,
  TransportError,
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
  /** Run a read against the replica: the posts it answers. */
  readonly posts: (read: Query.Read) => Effect.Effect<ReadonlyArray<Post>>;
  /** Every post the durable store holds, whatever any query would answer. */
  readonly stored: Effect.Effect<ReadonlyArray<Post>>;
}

const webCrypto = Layer.orDie(Digest.layerWebCrypto);

/**
 * The fingerprint a session stamps the replica with (`Identity.anonymous`
 * when signed out). (Hand-written glue: `SignOut` keeps this mapping private.)
 */
const fingerprintOf = (session: Option.Option<Session>): Effect.Effect<Identity.Fingerprint> =>
  Option.match(session, {
    onNone: () => Effect.succeed(Identity.anonymous),
    onSome: ({ user }) => SignOut.fingerprintOf(user.id).pipe(Effect.provide(webCrypto)),
  });

/**
 * The device's transport: the in-process sync server, presenting whatever
 * session cookie the jar holds on each call, as a browser's cookie jar does.
 * (Hand-written glue: `Transport.makeInMemory` fixes its credentials when it
 * is built, and its `setStatus` does not make calls fail.)
 */
const jarTransport = (
  audience: AudienceServer,
  clientGroupId: string,
  jar: Ref.Ref<Option.Option<Session>>,
  network: { online: boolean },
  status: SubscriptionRef.SubscriptionRef<Transport.ConnectionStatus>
): Transport.ClientTransport => {
  const handler = audience.server.handler;
  const withCookie = <A, E>(
    call: (options: Transport.HandleOptions) => Effect.Effect<A, E>
  ): Effect.Effect<A, E | TransportError> =>
    Effect.suspend((): Effect.Effect<A, E | TransportError> =>
      network.online
        ? Ref.get(jar).pipe(
            Effect.flatMap((session) =>
              call({
                credentials: Option.map(session, ({ token }) =>
                  Authorization.credentialsFromHeaders({ cookie: cookieHeader(token) })
                ),
              })
            )
          )
        : Effect.fail(new TransportError({ message: "the network is down" }))
    );
  return {
    push: (request) => withCookie((options) => handler.handlePush(request, options)),
    pull: (request) => withCookie((options) => handler.handlePull(request, options)),
    read: (request) => withCookie((options) => handler.handleRead(request, options)),
    pokes: handler.pokes(clientGroupId),
    status: SubscriptionRef.get(status),
    statusChanges: SubscriptionRef.changes(status),
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
    const jar = yield* Ref.make(Option.none<Session>());
    const network = { online: true };
    const status = yield* SubscriptionRef.make<Transport.ConnectionStatus>("connected");
    const clientGroupId = `group-${name}`;
    const { client, engine } = yield* Client.make({
      nodes,
      mutations,
      clientId: `client-${name}`,
      clientGroupId,
      store,
      transport: jarTransport(audience, clientGroupId, jar, network, status),
      // The tests drive push and pull, so every replica they read is settled.
      sync: false,
      identity: yield* fingerprintOf(Option.none()),
    });

    // Hand-written glue: the jar and the session-change listener kept in step.
    const onSessionChange = SignOut.onSessionChange(client);
    const change = (next: Option.Option<Session>) =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(jar, next);
        return yield* onSessionChange(previous, next).pipe(Effect.provide(webCrypto), Effect.orDie);
      });

    const facade = JsonApiFacade.fetchHandler({
      nodes,
      api,
      resources,
      view: client.view,
      coverageOf: client.coverageOf,
      totalOf: (subset) => Effect.map(client.totalOf(subset), Option.fromUndefinedOr),
      cookie: Effect.map(store.getCookie, Option.fromUndefinedOr),
      online: () => network.online,
    });

    const device: Device = {
      client,
      engine,
      store,
      facade,
      signIn: (session) => change(Option.some(session)),
      signOut: Effect.gen(function* () {
        const current = yield* Ref.get(jar);
        if (Option.isSome(current)) yield* audience.signOut(current.value);
        return yield* change(Option.none());
      }),
      setOnline: (online) =>
        Effect.suspend(() => {
          network.online = online;
          return SubscriptionRef.set(status, online ? "connected" : "disconnected");
        }),
      posts: (read) =>
        client.query(read).pipe(
          Effect.map((rows) => rows.map((row) => row.value as Post)),
          Effect.orDie
        ),
      stored: store.listRows("posts").pipe(
        Effect.map((rows) => rows.map((row) => row.value as Post)),
        Effect.orDie
      ),
    };
    return device;
  });
