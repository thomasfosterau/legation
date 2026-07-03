/**
 * The sync stack both processes share: one `Server.make` (ADR-0022) over
 * the SqlBackend, the public/private auth split, and the identity seam.
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
 *
 * The invalidation bus is created here and passed INTO `Server.make`, so
 * the polling hint source (ADR-0019 tier 2) publishes into the same bus the
 * server's fan-out listens to, and `server.broadcast` is available to
 * out-of-band writers (the fulfilment worker).
 */
import { Context, Effect, Layer, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Authorization, InvalidationBus, Predicate, Server, Transport } from "@legation/effect";
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

/** The app's Server (handler + broadcast) and the bus hint sources share. */
export interface CommerceSync {
  readonly server: Server.Server;
  readonly bus: InvalidationBus.InvalidationBus;
}
export const CommerceSync = Context.Service<CommerceSync>("commerce/CommerceSync");

/**
 * The one server-side object (ADR-0022): `Server.make` over the SqlBackend
 * and the auth seams. CVR storage defaults to per-process memory — a lost
 * cookie degrades to a reset patch (ADR-0008); cross-process writes are
 * covered by the polling hint source publishing into the shared bus.
 */
const commerceSync: Effect.Effect<CommerceSync, never, SqlClient | Scope.Scope> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const bus = yield* InvalidationBus.makeInProcess;
    const server = yield* Server.make({
      backend: SqlBackend.make({
        executor: makeExecutor(sql),
        tables,
        mutators: mutators.mutators,
        handlers: makeHandlers(sql),
      }),
      auth: {
        policy: authPolicy,
        identity: {
          resolve: (clientGroupId) =>
            currentUser(clientGroupId).pipe(
              Effect.provideService(SqlClient, sql),
              // An unreadable binding table is a server bug, not an auth verdict.
              Effect.orDie
            ),
        },
      },
      bus,
    });
    return { server, bus };
  });

export const syncLayer: Layer.Layer<
  Transport.ServerHandler | InvalidationBus.InvalidationBus | CommerceSync,
  never,
  SqlClient
> = Layer.mergeAll(
  Layer.effect(Transport.ServerHandler)(Effect.map(CommerceSync, (s) => s.server.handler)),
  Layer.effect(InvalidationBus.InvalidationBus)(Effect.map(CommerceSync, (s) => s.bus))
).pipe(Layer.provideMerge(Layer.effect(CommerceSync)(commerceSync)));
