/**
 * Hydration
 *
 * Move a client's durable state across a serialisation boundary: `dehydrate`
 * reads a {@link ClientStore} into a plain {@link Snapshot}; `hydrate` writes a
 * snapshot back into a store. Between the two the snapshot is JSON — the value
 * an SSR response embeds, a devtools export writes to disk, or a client hands to a
 * worker.
 *
 * ## SSR flow
 *
 * The server renders a page over a *real* engine per request: an in-memory
 * {@link ClientStore} plus a {@link ClientTransport} to the sync server. It
 * `subscribe`s the subsets the page needs, `pull`s once, then `dehydrate`s the
 * store — capturing the confirmed rows, the pull cookie, and any journalled
 * mutations. That snapshot ships to the browser (JSON-encoded in the document).
 * The client builds its durable store, `hydrate`s the snapshot into it, and
 * constructs the engine over that store. The first render already has rows (no
 * loading flash), and because the cookie came across too the client's first
 * pull continues the CVR conversation from where the server left off — no
 * refetch of state the server already sent.
 *
 * The transport is the seam that makes this work off-process. Pull is the
 * correctness path, so subscribe → pull → dehydrate behaves identically
 * against a remote Server: the renderer need not hold the backend. A
 * single-process app passes nothing and gets a loop-back transport over the
 * in-context {@link ServerHandler}; a split deployment (a SvelteKit Worker
 * rendering against a separate API Worker) passes its own carrier.
 *
 * ## A store the client does not own
 *
 * When the engine and its durable store live in an engine host (a service
 * worker, an elected tab), the tab holds the snapshot but not the store, so
 * it hands the snapshot over: the `hydrate` request kind ({@link requests}),
 * answered by a host given its store. The host owns the empty-store gate
 * ({@link hydrateUnpulled}): it hydrates only an empty store whose engine has
 * not started a pull, and answers every other snapshot `hydrated: false`
 * with the reason ({@link HydrateOutcome}). {@link makeGate}'s `hold` lets a
 * cold host wait for the first snapshot before it pulls.
 *
 * ## Seeded-versions caveat
 *
 * A snapshot carries each row's authoritative `version`. Those versions must be
 * genuine backend versions for CVR diffing to converge cheaply on the next
 * pull: the server compares them against its record and sends only the delta.
 * Self-invented versions are *safe* — they never corrupt state — but they will
 * not match the server's CVR, so the next pull degrades to the reset path (the
 * server sends a `Clear` followed by full puts). The same caveat applies to
 * {@link ClientEngine.seed}.
 *
 * ## Validation
 *
 * `hydrate` decodes the snapshot through {@link Snapshot} before writing,
 * so a `dehydrate → JSON.stringify → JSON.parse → hydrate` round-trip is
 * schema-checked end to end; a malformed snapshot fails as a `StoreError`.
 * Only the *envelopes* are validated — row values and mutation args stay
 * `Unknown` and round-trip untouched (ADR-0014), exactly like the store's own
 * persisted codecs. Use {@link SnapshotFromJson} to fold the JSON step into the
 * decode.
 */

import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ClientEngineModule from "./ClientEngine.js";
import * as HostRequest from "./HostRequest.js";
import {
  ClientStore,
  freezePending,
  // oxlint-disable-next-line effect/no-service-constructor-imports -- the SSR render deliberately builds a private, request-scoped in-memory store (`snapshot` needs nothing from context); providing it via a Layer would change the public `R` or share the memoized store across requests.
  makeMemory,
  type ReplicaState,
  StoredRow,
} from "./ClientStore.js";
import type { RequestCredentials } from "./Authorization.js";
import type { MutatorError, TransportError, VersionNotSupportedError } from "./Errors.js";
import { StoreError } from "./Errors.js";
import * as Mutator from "./Mutator.js";
import type * as Node from "./Node.js";
import { Mutation } from "./Protocol.js";
import * as Query from "./Query.js";
import * as Subset from "./Subset.js";
// oxlint-disable-next-line effect/no-service-constructor-imports -- the in-process SSR path builds a private loop-back transport over the `ServerHandler` in context, per call; a Layer would change `snapshot`'s public requirements.
import { ClientTransport, makeInMemory, ServerHandler } from "./Transport.js";

/**
 * One dehydrated row: a {@link StoredRow} tagged with the collection it belongs
 * to, so the flat `rows` array reconstructs the per-collection layout on
 * hydrate. `value` stays `Unknown` (envelope-validated only, ADR-0014).
 */
export const SnapshotRow = Schema.Struct({
  collection: Schema.String,
  ...StoredRow.fields,
});

/**
 * A serialisable capture of a {@link ClientStore}: confirmed rows (flattened
 * with their collection), the pull cookie, the pending-mutation journal, the
 * acknowledged-but-unpulled tail (#336), and each client's mutation id counter
 * (#271). The tail and the counters are optional so a snapshot taken before
 * they existed still loads, as an empty tail and no counters. The schema is
 * the source of truth; {@link Snapshot} is derived from it.
 *
 * The counters are what let a client id be reused across the hydration
 * boundary: once acknowledgements have drained the journal, they are the only
 * record of the ids the backend has already applied, and a hydrated store
 * without them would issue those ids again, which the backend skips as
 * duplicates (a silent lost write).
 */
export const Snapshot = Schema.Struct({
  rows: Schema.Array(SnapshotRow),
  cookie: Schema.optional(Schema.String),
  journal: Schema.Array(Mutation),
  unpulled: Schema.optional(Schema.Array(Mutation)),
  counters: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
    )
  ),
});

/** The type {@link Snapshot} decodes to. */
export type Snapshot = typeof Snapshot.Type;

/** The type {@link SnapshotRow} decodes to. */
export type SnapshotRow = typeof SnapshotRow.Type;

/**
 * JSON codec for a {@link Snapshot}: `decode` parses a JSON string and validates
 * it in one step (SSR/devtools ingest), `encode` produces the JSON string.
 */
export const SnapshotFromJson = Schema.fromJsonString(Snapshot);

/** The type {@link SnapshotFromJson} decodes to. */
export type SnapshotFromJson = typeof SnapshotFromJson.Type;

const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause });

/**
 * The replica read member by member: the path for a store without `snapshot`. Its reads are not one
 * state, so a pull or a push acknowledgement can land between them (#392).
 */
const readMembers = (store: ClientStore): Effect.Effect<ReplicaState, StoreError> =>
  Effect.gen(function* () {
    const rows: Array<{ readonly collection: string; readonly row: StoredRow }> = [];
    yield* Effect.forEach(
      yield* store.listCollections,
      (collection) =>
        Effect.gen(function* () {
          Arr.forEach(yield* store.listRows(collection), (row) => {
            rows.push({ collection, row });
          });
        }),
      { concurrency: 1, discard: true }
    );
    return {
      rows,
      cookie: yield* store.getCookie,
      journal: yield* store.pendingMutations,
      unpulled: yield* store.unpulled,
      counters: yield* store.mutationCounters,
    };
  });

/**
 * Read a {@link ClientStore} into a {@link Snapshot}: enumerate the collections,
 * gather their confirmed rows (flattened with the collection), the cookie, the
 * journal, the unpulled tail and the mutation counters. The tail and the
 * counters are each left out when empty, so a snapshot without them keeps its
 * previous shape.
 *
 * The five parts are one state when the store offers {@link ClientStore.snapshot}
 * (the memory and key-value stores do): a pull or a push acknowledgement lands wholly
 * before or wholly after the read (#392). A store without it is read member by member.
 */
export const dehydrate = (store: ClientStore): Effect.Effect<Snapshot, StoreError> =>
  Effect.gen(function* () {
    const state = yield* store.snapshot ?? readMembers(store);
    const base: Snapshot = {
      rows: state.rows.map(({ collection, row }) => ({
        collection,
        id: row.id,
        version: row.version,
        value: row.value,
      })),
      ...(state.cookie !== undefined ? { cookie: state.cookie } : {}),
      journal: state.journal,
      ...(Arr.isReadonlyArrayNonEmpty(state.unpulled) ? { unpulled: state.unpulled } : {}),
    };
    return R.isEmptyRecord(state.counters) ? base : { ...base, counters: state.counters };
  });

/**
 * Write a {@link Snapshot} into a {@link ClientStore}: validate it through
 * {@link Snapshot} (so a malformed snapshot fails as a `StoreError`), then
 * put the rows, set the cookie if present, park the unpulled tail, raise the
 * store's mutation counters to the snapshot's, and append the journal, skipping
 * any entry the tail already holds. A snapshot without a tail parks nothing. An
 * outstanding pull release is finished first.
 *
 * The counters are raised, never lowered (#271): a client id reused after
 * hydration continues above every id the snapshot's store had issued, so it
 * never reissues an id the backend has already applied. A snapshot without
 * counters leaves the store's as they are.
 *
 * A running {@link ClientEngine} built over the store re-reads its view and built
 * indexes afterwards: a direct write does not go through the engine, so without this
 * an indexed query could return a row whose indexed field changed (#350). The re-read
 * runs when a write fails too, since the rows written before the failure are in the
 * store. It reaches only the engines built over this exact store object: a store
 * wrapped in a new object (`ClientStore.of({ ...store })`) is not seen, so its engine
 * can stay stale. The same re-read tracks the appended journal entries in its
 * `mutationStates` as `"pending"` (#358), so they settle like a local mutation. Journal ids
 * should be ids this client has not already settled: an id the map has evicted is tracked again,
 * and its outcome event can then follow a second time.
 *
 * The writes are not atomic. Between the first `putRow` and the re-read, an indexed
 * read on an async store can see the old index against the new rows. Once `hydrate`
 * returns or fails, the engine's view and indexes match the store again.
 *
 * `hydrate` does not take the overlay lock of an engine built over the store, so it must
 * not run while that engine is pulling. Its first step finishes an outstanding pull release
 * (#387). If that release is a live pull's, the pull's remaining row writes then land over
 * the snapshot's rows. Hydrate before the engine starts, or while it is stopped.
 */
export const hydrate = (store: ClientStore, snapshot: Snapshot): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(Snapshot)(snapshot).pipe(
      Effect.mapError(storeError("Invalid snapshot"))
    );
    yield* Effect.gen(function* () {
      // An outstanding pull release goes first: its record would re-apply its patch over the
      // snapshot's rows on the next open, so it is finished before the snapshot is written (#387).
      yield* store.finishRelease;
      yield* Effect.forEach(
        decoded.rows,
        ({ collection, ...row }) =>
          Effect.gen(function* () {
            yield* store.putRow(collection, row);
          }),
        { concurrency: 1, discard: true }
      );
      if (decoded.cookie !== undefined) yield* store.setCookie(decoded.cookie);
      // The tail's effects are already in the rows, and the next pull releases it (#336).
      if (decoded.unpulled !== undefined) yield* store.parkUnpulled(decoded.unpulled);
      // Once acks drain the journal, the counters are the only record of the ids already applied (#271).
      if (decoded.counters !== undefined) yield* store.raiseMutationCounters(decoded.counters);
      // A snapshot read member by member (a store without `snapshot`) can hold a push acknowledgement's
      // entry in both its journal and its tail, since the two reads are not one state. The tail copy wins:
      // it is not journaled again (#387). The store's tail is read too, since an entry the store already
      // parked can sit in a snapshot's journal; `appendMutation` refuses such an entry, so it must be skipped.
      const parked = new Set(
        (yield* store.unpulled).map((m) => `${m.clientId}\u0000${m.mutationId}`)
      );
      yield* Effect.forEach(
        decoded.journal,
        (mutation) =>
          Effect.gen(function* () {
            if (parked.has(`${mutation.clientId}\u0000${mutation.mutationId}`)) return;
            yield* store.appendMutation(mutation);
          }),
        { concurrency: 1, discard: true }
      );
      // These entries came from another context: whether they were pushed there
      // is unknowable here, so paced compaction must not renumber them (#249).
      yield* freezePending(store);
    }).pipe(
      // A refused write leaves the rows before it in the store, so the re-read
      // runs on failure too (#350).
      Effect.ensuring(ClientEngineModule.resyncAttachedEngines(store))
    );
  });

/**
 * Whether a store holds nothing: no rows, no cookie, no journalled or unpulled mutations.
 * The "fresh browser" test {@link hydrateIfEmpty} gates on.
 */
export const isEmpty = (store: ClientStore): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    if ((yield* store.getCookie) !== undefined) return false;
    if (Arr.isReadonlyArrayNonEmpty(yield* store.pendingMutations)) return false;
    if (Arr.isReadonlyArrayNonEmpty(yield* store.unpulled)) return false;
    const holding = yield* Effect.findFirst(yield* store.listCollections, (collection) =>
      Effect.map(store.listRows(collection), Arr.isReadonlyArrayNonEmpty)
    );
    return Option.isNone(holding);
  });

/**
 * {@link hydrate}, but only into an empty store; returns whether it hydrated.
 *
 * This is the right client-boot default over a *durable* store: on a repeat
 * visit the store already holds rows, a cookie, and possibly journalled
 * offline mutations that are all fresher than the SSR snapshot — hydrating
 * over them would regress the cookie (and with it the CVR conversation) and
 * clobber newer confirmed rows. An empty store (first visit, cleared storage)
 * takes the snapshot wholesale.
 */
export const hydrateIfEmpty = (
  store: ClientStore,
  snapshot: Snapshot
): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    if (!(yield* isEmpty(store))) return false;
    yield* hydrate(store, snapshot);
    return true;
  });

/**
 * Why a host declined a snapshot (ADR-0021 amendment §6): its store already
 * holds state (`NotEmpty`), or a pull has started since its engine booted
 * (`AlreadyPulling`), which is about to fill the store and whose cookie the
 * snapshot's would race.
 */
export const HydrateDeclined = Schema.Literals(["NotEmpty", "AlreadyPulling"]);

/** The type {@link HydrateDeclined} decodes to. */
export type HydrateDeclined = typeof HydrateDeclined.Type;

/**
 * What a host answers a `hydrate` request with: whether it wrote the snapshot
 * into its store, and, when it did not, why. A `false` answer is never an
 * error and needs no action: the host's replica is then at least as fresh as
 * the snapshot.
 */
export const HydrateOutcome = Schema.Struct({
  // oxlint-disable-next-line effect/require-is-prefix-for-boolean-schema-field -- the `hydrate` kind's published wire contract (ADR-0021 amendment §6) names this field `hydrated`.
  hydrated: Schema.Boolean,
  reason: Schema.optional(HydrateDeclined),
});

/** The type {@link HydrateOutcome} decodes to. */
export type HydrateOutcome = typeof HydrateOutcome.Type;

/**
 * The hydration host-request kind (ADR-0021 amendment §6, #146): a tab holding
 * a server-rendered {@link Snapshot} hands it to the engine host it mirrors,
 * which owns the store and the empty-store gate. Single-reply; the answer is a
 * {@link HydrateOutcome}. Ask it with `Mirror.request(Hydration.requests.hydrate,
 * snapshot)`; a host serves it once it is given its store (`EngineHost.run({
 * store })`).
 */
export const requests = {
  hydrate: HostRequest.single("hydrate", { request: Snapshot, response: HydrateOutcome }),
} as const;

const HYDRATED: HydrateOutcome = { hydrated: true };

/**
 * The gate itself, for a caller already holding the engine's pulls: the store
 * must be empty and no pull may have started. Uninterruptible once it has
 * decided, so a cancelled request never leaves a half-written snapshot.
 */
const hydrateHeld = (
  counts: ClientEngineModule.PullCounts,
  store: ClientStore,
  snapshot: Snapshot
): Effect.Effect<HydrateOutcome, StoreError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (!(yield* isEmpty(store))) return { hydrated: false, reason: "NotEmpty" } as const;
      if (counts.started > 0) return { hydrated: false, reason: "AlreadyPulling" } as const;
      yield* hydrate(store, snapshot);
      return HYDRATED;
    })
  );

/**
 * {@link hydrate} into a running engine's store, gated as an engine host gates
 * it (ADR-0021 amendment §6): with the engine's pulls held
 * (`ClientEngine.withPullsHeld`), it hydrates iff the store {@link isEmpty}
 * and no pull has started since the engine was built. Otherwise it answers
 * `hydrated: false` with the reason and leaves the store untouched. Of two
 * snapshots offered to one empty store, the first to take the pulls wins and
 * the other is answered `NotEmpty` (unless the winner was itself empty).
 * After a hydration, the engine re-syncs as {@link hydrate} describes, and its
 * first pull continues from the snapshot's cookie.
 *
 * The check and the write are one section against pulls, not against local
 * mutations: a mutation journaled between them is kept beside the snapshot's
 * journal.
 */
export const hydrateUnpulled = (
  engine: ClientEngineModule.ClientEngine,
  store: ClientStore,
  snapshot: Snapshot
): Effect.Effect<HydrateOutcome, StoreError> =>
  engine.withPullsHeld((counts) => hydrateHeld(counts, store, snapshot));

/** A host's hydration gate: what serves the `hydrate` kind ({@link makeGate}). */
export interface Gate {
  /** Offer a snapshot to the host's store: {@link hydrateUnpulled}, through the gate's hold if it is still open. */
  readonly hydrate: (snapshot: Snapshot) => Effect.Effect<HydrateOutcome, StoreError>;
}

/** Options for {@link makeGate}. */
export interface GateOptions {
  /**
   * How long to hold the engine's pulls for a snapshot when the gate is made
   * over an empty store that has not pulled. Unset, nothing is held and every
   * snapshot races the engine's pulls (the first pull wins, and later
   * snapshots are `AlreadyPulling`). See `EngineHostOptions.hydrationWindow`.
   */
  readonly hold?: Duration.Input | undefined;
}

interface Job {
  readonly snapshot: Snapshot;
  readonly reply: Deferred.Deferred<HydrateOutcome, StoreError>;
}

/** The hold's state: whether it is still holding, and the snapshot handed over to it, if any. */
interface Hold {
  readonly holding: boolean;
  readonly job: Option.Option<Job>;
}

const RELEASED: Hold = { holding: false, job: Option.none() };

/**
 * Build a host's hydration gate over its engine and store. Without `hold` it
 * is {@link hydrateUnpulled}. With `hold`, and when the store is empty and no
 * pull has started, the gate first takes the engine's pulls and keeps them
 * until a snapshot arrives or `hold` elapses, whichever is first: a cold host
 * (a service worker the first tab's handshake just started) would otherwise
 * pull on connect before the tab's snapshot crosses the mirror, and the
 * snapshot would always lose. The first snapshot in that window is hydrated
 * under the held pulls; anything later goes through {@link hydrateUnpulled}.
 * A store that is not empty, or an engine that has pulled, releases at once.
 *
 * Returns once the hold (if any) is in place, so a pull that starts after the
 * gate is made waits for it. The hold ends with the scope.
 */
export const makeGate = (
  engine: ClientEngineModule.ClientEngine,
  store: ClientStore,
  options: GateOptions = {}
): Effect.Effect<Gate, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { hold } = options;
    const direct = (snapshot: Snapshot) => hydrateUnpulled(engine, store, snapshot);
    if (hold === undefined) return { hydrate: direct };
    const state = yield* Ref.make<Hold>({ holding: true, job: Option.none() });
    const arrived = yield* Deferred.make<void>();
    const holding = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      engine.withPullsHeld((counts) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(holding, undefined);
          const eligible =
            counts.started === 0 && (yield* isEmpty(store).pipe(Effect.orElseSucceed(() => false)));
          if (eligible) yield* Deferred.await(arrived).pipe(Effect.timeoutOption(hold));
          // Close the hold and take whatever job was handed over, as one step: a
          // snapshot that arrives after this goes through the pulls like any other.
          const claimed = yield* Ref.getAndSet(state, RELEASED);
          if (Option.isSome(claimed.job)) {
            const { snapshot, reply } = claimed.job.value;
            yield* Deferred.done(reply, yield* Effect.exit(hydrateHeld(counts, store, snapshot)));
          }
        })
      )
    );
    yield* Deferred.await(holding);
    return {
      hydrate: (snapshot) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<HydrateOutcome, StoreError>();
          const handedOver = yield* Ref.modify(state, (current): readonly [boolean, Hold] =>
            current.holding && Option.isNone(current.job)
              ? [true, { holding: true, job: Option.some({ snapshot, reply }) }]
              : [false, current]
          );
          if (!handedOver) return yield* direct(snapshot);
          yield* Deferred.succeed(arrived, undefined);
          return yield* Deferred.await(reply);
        }),
    };
  });

/** The host-side handler serving {@link requests}' `hydrate` kind through a {@link Gate}. */
export const handler = (gate: Gate): HostRequest.Handler =>
  HostRequest.handler(requests.hydrate, gate.hydrate);

/**
 * Project a snapshot onto a read, locally and synchronously: the snapshot's
 * rows for the read's collection, filtered/sorted/windowed by the read's
 * compiled root window. This is how a component derives its initial value
 * (e.g. the rune hooks' `initial` option) from the page's snapshot — during
 * SSR and on first client render — without touching an engine.
 *
 * `include`d edges are not resolved here: a snapshot is flat rows, and
 * resolving edges is the Client's job once the engine is up. Seed the base
 * rows and let the first live emission fill the edges in.
 */
export const rowsFor = (
  snapshot: Snapshot,
  nodes: Node.NodeRegistry,
  read: Query.Read
): ReadonlyArray<ClientEngineModule.LocalRow> =>
  Subset.apply(
    snapshot.rows
      .filter((row) => row.collection === read.collection)
      .map((row) => ({ id: row.id, value: row.value })),
    Query.plan(nodes, read).root
  );

/** Options for {@link snapshot}. */
export interface SnapshotOptions {
  /**
   * The client group the render belongs to — the browser's group id (e.g.
   * carried in an HTTP cookie), so the cookie in the produced snapshot
   * continues that group's CVR conversation on the client's first pull.
   */
  readonly clientGroupId: string;
  /** Client id for the request-scoped engine (never pushes). Default `"ssr"`. */
  readonly clientId?: string;
  /** The node graph the reads compile against. */
  readonly nodes: Node.NodeRegistry;
  /** The reads the page needs — subscribed and pulled once. */
  readonly reads: ReadonlyArray<Query.Read>;
  /** Mutation registry for the request-scoped engine. Default: none. */
  readonly mutations?: Mutator.MutatorRegistry;
  /**
   * The carrier the request-scoped engine pulls over. Omit it for the
   * in-process default — a loop-back transport to the in-context
   * {@link ServerHandler} — which is what a single-process app wants.
   *
   * Pass one when the renderer is *not* the process holding the backend: a
   * SvelteKit Worker rendering against a separate API Worker, an SSR tier in
   * front of a remote sync server. Whatever the carrier, it must preserve the
   * CVR conversation end to end — the request's `clientGroupId` reaches the
   * Server unchanged, and the Server's fresh cookie comes back in the pull
   * response — or the snapshot's cookie belongs to a conversation the client
   * is not in, and its first pull silently degrades to the reset path.
   */
  readonly transport?: ClientTransport;
  /**
   * The credentials of the request the render acts for
   * (`Authorization.credentialsFromHeaders(request.headers)`), which the
   * in-process path presents to the server's `IdentityResolver`, so the
   * snapshot holds what that request's session may read (ADR-0035). Absent or
   * `None`: the render presents none (`Authorization.noCredentials`). Ignored
   * with a `transport`, which carries its own (a binding transport forwards
   * the request's cookie).
   */
  readonly credentials?: Option.Option<RequestCredentials>;
}

/** {@link SnapshotOptions} with the carrier supplied — no `ServerHandler` needed. */
export interface RemoteSnapshotOptions extends SnapshotOptions {
  readonly transport: ClientTransport;
}

/** What a snapshot render can fail with. */
export type SnapshotError = StoreError | TransportError | MutatorError | VersionNotSupportedError;

/** The snapshot render itself, over an already-built carrier. */
const renderOver = (
  transport: ClientTransport,
  options: SnapshotOptions
): Effect.Effect<Snapshot, SnapshotError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* makeMemory;
      const engine = yield* ClientEngineModule.make({
        clientId: options.clientId ?? "ssr",
        clientGroupId: options.clientGroupId,
        mutators: options.mutations ?? Mutator.registry([]),
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
      yield* Effect.forEach(
        options.reads,
        (read) =>
          Effect.gen(function* () {
            yield* engine.subscribe(Query.plan(options.nodes, read).root);
          }),
        { concurrency: 1, discard: true }
      );
      yield* engine.pull;
      return yield* dehydrate(store);
    })
  );

/**
 * Produce an SSR snapshot over a request-scoped engine: build an in-memory
 * {@link ClientStore}, subscribe the page's subsets over the given
 * {@link ClientTransport}, pull once, and {@link dehydrate}. Everything is
 * scoped to the call — nothing outlives it.
 *
 * With `options.transport` the render needs nothing from context; without it
 * the in-process path applies and the app's sync server is taken from context
 * as `ServerHandler`, carried by a loop-back transport.
 *
 * This is the server half of the SSR flow described above; run it inside a
 * request handler (a SvelteKit `load`, a Next.js loader). Framework packages
 * wrap this — they add the framework's own plumbing (a cookie, a `load`
 * signature), never their own hydration logic.
 */
export function snapshot(options: RemoteSnapshotOptions): Effect.Effect<Snapshot, SnapshotError>;
/** The in-process form: renders against the app's sync server, the `ServerHandler` in context. */
export function snapshot(
  options: SnapshotOptions
): Effect.Effect<Snapshot, SnapshotError, ServerHandler>;
export function snapshot(
  options: SnapshotOptions
): Effect.Effect<Snapshot, SnapshotError, ServerHandler> {
  const supplied = options.transport;
  if (supplied !== undefined) return renderOver(supplied, options);
  return Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* ServerHandler;
      const transport = yield* makeInMemory(handler, options.clientGroupId, {
        credentials: options.credentials ?? Option.none(),
      });
      return yield* renderOver(transport, options);
    })
  );
}
