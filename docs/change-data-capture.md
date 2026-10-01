# Change data capture (out-of-band writes)

Fan-out pokes a subscribed client when a committed push produces change hints
(ADR-0009). That only covers writes that go **through a mutator**. A write that
bypasses the mutators — a cron job, an admin tool, another service, a `psql`
session — produces no hint, so a subscribed client only picks it up on its next
interval pull. Sync stays correct (pull is the correctness path), but the change
is not realtime.

A **hint source** closes that gap: it produces `ChangeHint`s for out-of-band
writes and publishes them to the `InvalidationBus`, so the same fan-out loop
pokes affected clients. Every tier below feeds the one seam,
`HintSource` (`@legation/effect`), and forks alongside the SyncServer:

```ts
import { HintSource } from "@legation/effect/internal";

// Fork a source onto the caller's scope; it stops when the scope closes.
yield * HintSource.run(source);
```

A source that publishes **value-less** hints (no `values`) is matched at the
collection level by the predicate-aware fan-out matcher (#42): every group
subscribed to the changed collection is poked and reconciles on its next pull.
That is sound — over-matching a poke only costs an empty pull; poke is never a
correctness dependency (ADR-0009).

The tiers, cheapest first. Pick the one whose operational cost you are willing
to pay (ADR-0019).

## Tier 1 — app-hint (the baseline)

If the writer is your code, publish the hint directly. This needs nothing new:

```ts
import { InvalidationBus } from "@legation/effect/internal";

// After an out-of-band write to the todos collection:
yield * InvalidationBus.publish([{ collection: "todos", ids: ["1"] }]);
```

Over a shared broker (`BusBrokers` — a Durable Object broadcast, Redis
pub/sub, …) the hint reaches every instance, so a write on one node pokes
subscribers on all of them. Carry `ids` (and, if cheap, row `values`) to let the
fan-out matcher poke by predicate instead of by collection.

## Tier 2 — polling (`@legation/sql`)

When you cannot make every writer publish a hint, poll the database. The polling
hint source reads a cheap change-detector per table on an interval and pokes a
collection whose detector moved. It uses only the `SqlExecutor` seam you already
provide to `SqlBackend` — no extra dependency.

```ts
import { HintSource } from "@legation/effect/internal";
import { PollingHintSource } from "@legation/sql";

const source = PollingHintSource.make({
  executor, // the same SqlExecutor your SqlBackend uses
  tables: { todos: { table: "todos", versionColumn: "version" } },
  interval: "5 seconds",
});

// Fork it alongside the SyncServer / SyncRoom, in the same scope.
yield * HintSource.run(source);
```

- **Bounded staleness = the interval.** An out-of-band write is delivered within
  one poll of when it lands.
- **Extra DB load.** Each poll runs one detector query per configured table
  (`SELECT COUNT(*) AS n, MAX(version) AS v FROM table`, or just `COUNT(*)`
  without a version column). Size the interval against that cost.
- **`versionColumn` caveat.** `COUNT(*) + MAX(version)` catches inserts,
  deletes, and version-bumping updates. A table with **no** monotonic version
  column can only detect row-count changes — an in-place update that keeps the
  row count and has no version column is missed. Map a `versionColumn` (or an
  `updated_at`) for full coverage.

## Tier 3 — Postgres `LISTEN`/`NOTIFY` (recipe — bring your own pg client)

For push-based, low-latency capture on Postgres, have the database notify on
every write and feed those notifications into a `HintSource`. This is a
**recipe, not shipped code**: you own the trigger DDL and the pg client (the
engine ships no `pg` dependency).

The trigger DDL (yours to run) notifies on the `legation_hints` channel with the
changed table and row id:

```sql
CREATE OR REPLACE FUNCTION legation_notify_hint() RETURNS trigger AS $$
DECLARE
  row_id text := COALESCE(NEW.id, OLD.id)::text;
BEGIN
  PERFORM pg_notify(
    'legation_hints',
    json_build_object('collection', TG_TABLE_NAME, 'id', row_id)::text
  );
  RETURN NULL; -- AFTER trigger, result ignored
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER todos_legation_hint
  AFTER INSERT OR UPDATE OR DELETE ON todos
  FOR EACH ROW EXECUTE FUNCTION legation_notify_hint();
```

A code sketch: open a `LISTEN` on your pg client, decode each payload into a
`ChangeHint`, and feed the stream to `HintSource.fromStream`. The pg client and
its `Stream` adapter are yours; the decode and the seam are all the engine
needs.

```ts
import { Effect, Schema, Stream } from "effect";
import { HintSource } from "@legation/effect/internal";

const HintPayload = Schema.fromJsonString(
  Schema.Struct({ collection: Schema.String, id: Schema.String })
);
const decode = Schema.decodeUnknownEffect(HintPayload);

// `notifications` is a Stream<string> of raw NOTIFY payloads from your pg
// client's LISTEN on the 'legation_hints' channel (bring your own adapter).
const hints = notifications.pipe(
  Stream.mapEffect((payload) =>
    decode(payload).pipe(
      Effect.map((p) => [{ collection: p.collection, ids: [p.id] }]),
      // Correctness never depends on the bus: skip a malformed payload, the
      // next pull repairs any missed poke (ADR-0009).
      Effect.catch(() => Effect.succeed<ReadonlyArray<{ collection: string; ids: string[] }>>([]))
    )
  ),
  Stream.filter((batch) => batch.length > 0)
);

yield * HintSource.run(HintSource.fromStream(hints));
```

If this recipe ever becomes shipped code, its home is a future `@legation/pg`
package, not core (ADR-0006).

## Not shipped — tier 4 (logical replication)

Decoding the write-ahead log with a replication slot is the operational pipeline
the BYO contract deliberately avoids owning (ADR-0009), so the engine does not
ship it (ADR-0019). An app that wants it can run its own WAL consumer and feed
`HintSource.fromStream` — the tier-3 shape generalises.
