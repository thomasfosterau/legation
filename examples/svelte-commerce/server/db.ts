/**
 * SQLite database — the app's authoritative storage.
 *
 * A `node:sqlite` implementation of `@legation/sql`'s `SqlExecutor` seam plus
 * the schema DDL and catalog seed. WAL mode so the SvelteKit server process
 * (SSR loads, no-JS form actions) and the sync server process share the file.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { BackendError } from "@legation/effect";
import type { SqlBackend } from "@legation/sql";

export const openDatabase = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(DDL);
  return db;
};

/** `SqlExecutor` over a synchronous `node:sqlite` handle. */
export const makeExecutor = (db: DatabaseSync): SqlBackend.SqlExecutor => {
  const fail = (message: string) => (cause: unknown) => new BackendError({ message, cause });
  return {
    query: (fragment) =>
      Effect.try({
        try: () =>
          db.prepare(fragment.text).all(...(fragment.params as Array<never>)) as Array<
            Record<string, unknown>
          >,
        catch: fail(`query failed: ${fragment.text}`),
      }),
    run: (fragment) =>
      Effect.try({
        try: () => void db.prepare(fragment.text).run(...(fragment.params as Array<never>)),
        catch: fail(`statement failed: ${fragment.text}`),
      }),
    transaction: (effect) =>
      Effect.acquireUseRelease(
        Effect.try({ try: () => db.exec("BEGIN IMMEDIATE"), catch: fail("BEGIN failed") }),
        () => effect,
        (_, exit) =>
          Effect.sync(() => {
            db.exec(exit._tag === "Success" ? "COMMIT" : "ROLLBACK");
          })
      ),
  };
};

const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, categoryId TEXT NOT NULL, sellerId TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, priceCents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY, productId TEXT NOT NULL, sku TEXT NOT NULL,
  name TEXT NOT NULL, priceCents INTEGER NOT NULL, stock INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, productId TEXT NOT NULL, userId TEXT NOT NULL,
  authorName TEXT NOT NULL, rating INTEGER NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cartItems (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, variantId TEXT NOT NULL, qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, status TEXT NOT NULL,
  totalCents INTEGER NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orderItems (
  id TEXT PRIMARY KEY, orderId TEXT NOT NULL, userId TEXT NOT NULL,
  variantId TEXT NOT NULL, qty INTEGER NOT NULL, priceCents INTEGER NOT NULL
);
-- Per-client mutation-id ledger (SqlBackend's exactly-once bookkeeping).
CREATE TABLE IF NOT EXISTS sync_mutations (
  client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
  PRIMARY KEY (client_group_id, client_id)
);
-- The browser's client group → authenticated user binding (IdentityResolver).
CREATE TABLE IF NOT EXISTS client_groups (
  clientGroupId TEXT PRIMARY KEY, userId TEXT NOT NULL
);
`;

const SEED = /* sql */ `
INSERT INTO categories (id, name, slug) VALUES
  ('c-audio', 'Audio', 'audio'),
  ('c-keyboards', 'Keyboards', 'keyboards'),
  ('c-desks', 'Desks', 'desks');
INSERT INTO sellers (id, name) VALUES
  ('s-acme', 'Acme Peripherals'),
  ('s-nordic', 'Nordic Workshop');
INSERT INTO products (id, categoryId, sellerId, name, description, priceCents) VALUES
  ('p-01', 'c-audio', 's-acme', 'Studio Headphones', 'Closed-back monitoring headphones.', 14900),
  ('p-02', 'c-audio', 's-acme', 'USB Microphone', 'Cardioid condenser microphone.', 9900),
  ('p-03', 'c-keyboards', 's-acme', 'Tenkeyless Keyboard', 'Hot-swappable TKL board.', 12900),
  ('p-04', 'c-keyboards', 's-nordic', 'Ergonomic Split Keyboard', 'Columnar split with tenting.', 24900),
  ('p-05', 'c-desks', 's-nordic', 'Standing Desk', 'Dual-motor sit-stand desk.', 54900),
  ('p-06', 'c-desks', 's-nordic', 'Desk Shelf', 'Solid oak monitor shelf.', 8900);
INSERT INTO variants (id, productId, sku, name, priceCents, stock) VALUES
  ('v-01a', 'p-01', 'HP-BLK', 'Black', 14900, 12),
  ('v-01b', 'p-01', 'HP-WHT', 'White', 14900, 3),
  ('v-02a', 'p-02', 'MIC-STD', 'Standard', 9900, 20),
  ('v-03a', 'p-03', 'KB-TKL-R', 'Red switches', 12900, 8),
  ('v-03b', 'p-03', 'KB-TKL-B', 'Brown switches', 12900, 0),
  ('v-04a', 'p-04', 'KB-SPL', 'Kit', 24900, 5),
  ('v-05a', 'p-05', 'DSK-120', '120 cm', 54900, 2),
  ('v-05b', 'p-05', 'DSK-160', '160 cm', 59900, 4),
  ('v-06a', 'p-06', 'SHL-STD', 'Standard', 8900, 15);
INSERT INTO reviews (id, productId, userId, authorName, rating, body, createdAt) VALUES
  ('r-01', 'p-01', 'seed-user', 'Ada', 5, 'Flat response, comfy pads.', '2026-06-01T10:00:00Z'),
  ('r-02', 'p-03', 'seed-user', 'Grace', 4, 'Great board, stabilisers need lube.', '2026-06-10T09:30:00Z'),
  ('r-03', 'p-05', 'seed-user', 'Alan', 5, 'Rock solid at full height.', '2026-06-15T16:45:00Z');
`;

/** Seed the catalog once (idempotent via the categories sentinel row). */
export const seed = (db: DatabaseSync): void => {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number };
  if (existing.n === 0) db.exec(SEED);
};
