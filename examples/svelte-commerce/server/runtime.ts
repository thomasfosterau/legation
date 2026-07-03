/**
 * The sync stack both processes share: SqlBackend over the SQLite executor,
 * the public/private auth split, and the identity seam.
 *
 * - Public catalog collections are `allowAll` — the deliberate opt-in for
 *   anonymous readers (deny-by-default holds everywhere else).
 * - Private collections are scoped by an identity predicate: signed-in users
 *   see exactly their rows; anonymous clients get an empty allow-set (the
 *   subscription syncs nothing, and mutators reject).
 * - Identity comes from the `client_groups` binding (browser client group →
 *   authenticated user), written by the app's sign-in action and read here by
 *   the `IdentityResolver` — never from anything the client sends in a push.
 */
import type { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { Authorization, Backend, Cvr, InvalidationBus, Predicate, SyncServer, Transport } from "@legation/effect";
import { SqlBackend } from "@legation/sql";
import { mutators, privateCollections, publicCollections } from "../src/lib/domain.js";
import { makeExecutor } from "./db.js";
import { handlers, tables } from "./handlers.js";

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
export const identityResolver = (db: DatabaseSync): Authorization.IdentityResolver => ({
  resolve: (clientGroupId) =>
    Effect.sync(() => {
      const row = db
        .prepare("SELECT userId FROM client_groups WHERE clientGroupId = ?")
        .get(clientGroupId) as { userId: string } | undefined;
      return row?.userId;
    }),
});

/** Bind (or unbind) a browser's client group to a user at sign-in/out. */
export const bindClientGroup = (db: DatabaseSync, clientGroupId: string, userId: string | undefined): void => {
  if (userId === undefined) {
    db.prepare("DELETE FROM client_groups WHERE clientGroupId = ?").run(clientGroupId);
  } else {
    db.prepare(
      "INSERT OR REPLACE INTO client_groups (clientGroupId, userId) VALUES (?, ?)"
    ).run(clientGroupId, userId);
  }
};

export const backend = (db: DatabaseSync): Backend.Backend =>
  SqlBackend.make({
    executor: makeExecutor(db),
    tables,
    mutators: mutators.mutators,
    handlers,
  });

/**
 * The full ServerHandler stack over one database handle, with the
 * invalidation bus exposed alongside so hint sources publish into the same
 * bus the fan-out listens to. CVR storage and the bus are per-process
 * (in-memory) — a lost cookie degrades to a reset patch (ADR-0008), and
 * cross-process writes are covered by the polling hint source in the sync
 * server.
 */
export const syncLayer = (
  db: DatabaseSync
): Layer.Layer<Transport.ServerHandler | InvalidationBus.InvalidationBus> =>
  SyncServer.layer.pipe(
    Layer.provide(Cvr.layerMemoryStore),
    Layer.provideMerge(InvalidationBus.layerInProcess),
    Layer.provide(Layer.succeed(Backend.Backend)(backend(db))),
    Layer.provide(Layer.succeed(Authorization.AuthPolicy)(authPolicy)),
    Layer.provide(Layer.succeed(Authorization.IdentityResolver)(identityResolver(db)))
  );
