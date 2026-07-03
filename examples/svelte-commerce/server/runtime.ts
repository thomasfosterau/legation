/**
 * The sync stack both processes share: SqlBackend over the Effect SQL
 * client, the public/private auth split, and the identity seam.
 *
 * - Public catalog collections are `allowAll` — the deliberate opt-in for
 *   anonymous readers (deny-by-default holds everywhere else).
 * - Private collections are scoped by an identity predicate: signed-in users
 *   see exactly their rows; anonymous clients get an empty allow-set (the
 *   subscription syncs nothing, and mutators reject).
 * - Identity comes from the `client_groups` binding (browser client group →
 *   authenticated user), written by the sync server's account API and read
 *   here by the `IdentityResolver` — never from anything the client sends
 *   in a push.
 */
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  Authorization,
  Backend,
  Cvr,
  InvalidationBus,
  Predicate,
  SyncServer,
  Transport,
} from "@legation/effect";
import { SqlBackend } from "@legation/sql";
import { mutators, privateCollections, publicCollections } from "../src/lib/domain.js";
import { makeExecutor } from "./db.js";
import { makeHandlers, tables } from "./handlers.js";

/** Identity-scoped filter over the given row field (ADR-0015 allow-set). */
const scopedBy =
  (field: string): Authorization.AuthFilter =>
  (context) =>
    Effect.succeed(
      typeof context.identity === "string"
        ? Predicate.eq(field, context.identity)
        : // Anonymous: an empty allow-set — matches no rows, denies nothing loudly.
          Predicate.isIn(field, [])
    );

export const authPolicy: Authorization.AuthPolicy = Authorization.policy({
  ...Object.fromEntries(publicCollections.map((name) => [name, Authorization.allowAll])),
  ...Object.fromEntries(
    privateCollections.map((name) => [name, scopedBy(name === "profiles" ? "id" : "userId")])
  ),
});

/** clientGroupId → userId from the `client_groups` binding table. */
export const currentUser = (clientGroupId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ userId: string }>`
      SELECT userId FROM client_groups WHERE clientGroupId = ${clientGroupId}`;
    return rows[0]?.userId;
  });

/** Bind (or unbind) a browser's client group to a user at sign-in/out. */
export const bindClientGroup = (clientGroupId: string, userId: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    if (userId === undefined) {
      yield* sql`DELETE FROM client_groups WHERE clientGroupId = ${clientGroupId}`;
    } else {
      yield* sql`INSERT OR REPLACE INTO client_groups (clientGroupId, userId)
        VALUES (${clientGroupId}, ${userId})`;
    }
  });

const identityResolverLayer = Layer.effect(Authorization.IdentityResolver)(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return {
      resolve: (clientGroupId) =>
        currentUser(clientGroupId).pipe(
          Effect.provideService(SqlClient, sql),
          // An unreadable binding table is a server bug, not an auth verdict.
          Effect.orDie
        ),
    };
  })
);

const backendLayer = Layer.effect(Backend.Backend)(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return SqlBackend.make({
      executor: makeExecutor(sql),
      tables,
      mutators: mutators.mutators,
      handlers: makeHandlers(sql),
    });
  })
);

/**
 * The full ServerHandler stack over the in-context `SqlClient`, with the
 * invalidation bus exposed alongside so hint sources publish into the same
 * bus the fan-out listens to. CVR storage and the bus are per-process
 * (in-memory) — a lost cookie degrades to a reset patch (ADR-0008), and
 * cross-process writes are covered by the polling hint source in the sync
 * server.
 */
export const syncLayer: Layer.Layer<
  Transport.ServerHandler | InvalidationBus.InvalidationBus,
  never,
  SqlClient
> = SyncServer.layer.pipe(
  Layer.provide(Cvr.layerMemoryStore),
  Layer.provideMerge(InvalidationBus.layerInProcess),
  Layer.provide(backendLayer),
  Layer.provide(Layer.succeed(Authorization.AuthPolicy)(authPolicy)),
  Layer.provide(identityResolverLayer)
);
