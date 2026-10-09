/**
 * SQLite database — the app's authoritative storage.
 *
 * Built on Effect's SQL packages: `@effect/sql-sqlite-node` provides the
 * `SqlClient` (WAL on by default, so the SvelteKit server process and the
 * sync server process share the file), and `@thomasfosterau/legation-sql`'s `SqlExecutor`
 * seam is a thin adapter over that client. Schema DDL and the catalog seed
 * run as an idempotent migration effect.
 */
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { SqlClient as SqlClientService } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { BackendError } from "@thomasfosterau/legation-effect";
import type { SqlBackend } from "@thomasfosterau/legation-sql";

/** The SQLite client layer both server processes build their stack on. */
export const clientLayer = (
  filename: string
): Layer.Layer<SqliteClient.SqliteClient | SqlClient, SqlError> => SqliteClient.layer({ filename });

/** `SqlExecutor` over the Effect SQL client (fragments → unsafe statements). */
export const makeExecutor = (sql: SqlClient): SqlBackend.SqlExecutor => {
  const asBackendError = (message: string) => (cause: unknown) =>
    new BackendError({ message, cause });
  return {
    query: (fragment) =>
      sql
        .unsafe<SqlBackend.SqlRow>(fragment.text, fragment.params)
        .pipe(Effect.mapError(asBackendError(`query failed: ${fragment.text}`))),
    run: (fragment) =>
      sql
        .unsafe(fragment.text, fragment.params)
        .pipe(Effect.asVoid, Effect.mapError(asBackendError(`statement failed: ${fragment.text}`))),
    transaction: (effect) =>
      sql.withTransaction(effect).pipe(
        Effect.catchTag("SqlError", (error) =>
          Effect.fail(new BackendError({ message: "transaction failed", cause: error }))
        )
      ),
  };
};

// Collation (ADR-0028 §4): every filterable or sortable text column must
// compare by code point, so the SQL tier orders and filters exactly as
// `Subset.apply` does. SQLite's default `BINARY` collation is bytewise over
// UTF-8 — already code-point order — so these columns carry no clause; a
// Postgres deployment declares them `COLLATE "C"` (`id TEXT COLLATE "C"
// PRIMARY KEY`, `createdAt TEXT COLLATE "C" NOT NULL`, …). `NOCASE` is never
// an option for such a column. The compilers emit an explicit collation on
// every text comparison regardless (#156), so the schema rule costs index
// use, not correctness, when it is missed.
const DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS sellers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, categoryId TEXT NOT NULL, sellerId TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL, priceCents INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS variants (
    id TEXT PRIMARY KEY, productId TEXT NOT NULL, sku TEXT NOT NULL,
    name TEXT NOT NULL, priceCents INTEGER NOT NULL, stock INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, productId TEXT NOT NULL, userId TEXT NOT NULL,
    authorName TEXT NOT NULL, rating INTEGER NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cartItems (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, variantId TEXT NOT NULL, qty INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, status TEXT NOT NULL,
    totalCents INTEGER NOT NULL, createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orderItems (
    id TEXT PRIMARY KEY, orderId TEXT NOT NULL, userId TEXT NOT NULL,
    variantId TEXT NOT NULL, qty INTEGER NOT NULL, priceCents INTEGER NOT NULL
  )`,
  // Per-client mutation-id ledger (SqlBackend's exactly-once bookkeeping).
  `CREATE TABLE IF NOT EXISTS sync_mutations (
    client_group_id TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id INTEGER NOT NULL,
    rejections TEXT,
    PRIMARY KEY (client_group_id, client_id)
  )`,
  // The browser's client group → authenticated user binding (IdentityResolver).
  `CREATE TABLE IF NOT EXISTS client_groups (
    clientGroupId TEXT PRIMARY KEY, userId TEXT NOT NULL
  )`,
];

/** Create the schema and seed the catalog once (idempotent). */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClientService;
  for (const statement of DDL) {
    yield* sql.unsafe(statement).unprepared;
  }
  const existing = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM categories`;
  if (existing[0]!.n > 0) return;

  yield* sql`INSERT INTO categories ${sql.insert([
    { id: "c-audio", name: "Audio", slug: "audio" },
    { id: "c-keyboards", name: "Keyboards", slug: "keyboards" },
    { id: "c-desks", name: "Desks", slug: "desks" },
  ])}`;
  yield* sql`INSERT INTO sellers ${sql.insert([
    { id: "s-acme", name: "Acme Peripherals" },
    { id: "s-nordic", name: "Nordic Workshop" },
  ])}`;
  yield* sql`INSERT INTO products ${sql.insert([
    { id: "p-01", categoryId: "c-audio", sellerId: "s-acme", name: "Studio Headphones", description: "Closed-back monitoring headphones.", priceCents: 14900 },
    { id: "p-02", categoryId: "c-audio", sellerId: "s-acme", name: "USB Microphone", description: "Cardioid condenser microphone.", priceCents: 9900 },
    { id: "p-03", categoryId: "c-keyboards", sellerId: "s-acme", name: "Tenkeyless Keyboard", description: "Hot-swappable TKL board.", priceCents: 12900 },
    { id: "p-04", categoryId: "c-keyboards", sellerId: "s-nordic", name: "Ergonomic Split Keyboard", description: "Columnar split with tenting.", priceCents: 24900 },
    { id: "p-05", categoryId: "c-desks", sellerId: "s-nordic", name: "Standing Desk", description: "Dual-motor sit-stand desk.", priceCents: 54900 },
    { id: "p-06", categoryId: "c-desks", sellerId: "s-nordic", name: "Desk Shelf", description: "Solid oak monitor shelf.", priceCents: 8900 },
  ])}`;
  yield* sql`INSERT INTO variants ${sql.insert([
    { id: "v-01a", productId: "p-01", sku: "HP-BLK", name: "Black", priceCents: 14900, stock: 12 },
    { id: "v-01b", productId: "p-01", sku: "HP-WHT", name: "White", priceCents: 14900, stock: 3 },
    { id: "v-02a", productId: "p-02", sku: "MIC-STD", name: "Standard", priceCents: 9900, stock: 20 },
    { id: "v-03a", productId: "p-03", sku: "KB-TKL-R", name: "Red switches", priceCents: 12900, stock: 8 },
    { id: "v-03b", productId: "p-03", sku: "KB-TKL-B", name: "Brown switches", priceCents: 12900, stock: 0 },
    { id: "v-04a", productId: "p-04", sku: "KB-SPL", name: "Kit", priceCents: 24900, stock: 5 },
    { id: "v-05a", productId: "p-05", sku: "DSK-120", name: "120 cm", priceCents: 54900, stock: 2 },
    { id: "v-05b", productId: "p-05", sku: "DSK-160", name: "160 cm", priceCents: 59900, stock: 4 },
    { id: "v-06a", productId: "p-06", sku: "SHL-STD", name: "Standard", priceCents: 8900, stock: 15 },
  ])}`;
  yield* sql`INSERT INTO reviews ${sql.insert([
    { id: "r-01", productId: "p-01", userId: "seed-user", authorName: "Ada", rating: 5, body: "Flat response, comfy pads.", createdAt: "2026-06-01T10:00:00Z" },
    { id: "r-02", productId: "p-03", userId: "seed-user", authorName: "Grace", rating: 4, body: "Great board, stabilisers need lube.", createdAt: "2026-06-10T09:30:00Z" },
    { id: "r-03", productId: "p-05", userId: "seed-user", authorName: "Alan", rating: 5, body: "Rock solid at full height.", createdAt: "2026-06-15T16:45:00Z" },
  ])}`;
});
