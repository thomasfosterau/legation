/**
 * ClientEngine
 *
 * The client-side engine: optimistic mutations into the journal, local
 * materialization (confirmed rows + optimistic overlay), subscriptions,
 * and the sync loop (push journal, pull patches, rebase).
 *
 * Rebase is recomputation (ADR-0008): the materialized view is always
 * "confirmed rows with pending mutations replayed on top", so applying a
 * patch and dropping acknowledged mutations IS the rebase — revealed
 * atomically through a single changes event.
 */

import { Clock, Context, Effect, Layer, Metric, PubSub, Ref, Schema, Scope, Stream } from "effect";
import type { RowId } from "./Collection.js";
import { ClientStore } from "./ClientStore.js";
import { MutatorError, QueryError, StoreError, TransportError } from "./Errors.js";
import * as LiveView from "./LiveView.js";
import type { LocalWriter, MutatorRegistry } from "./Mutator.js";
import type { Mutation, NamedSubscription, PatchOp, PullResponse } from "./Protocol.js";
import * as Query from "./Query.js";
import * as Telemetry from "./Telemetry.js";
import { ClientTransport } from "./Transport.js";
import * as Subset from "./Subset.js";

/** A locally-materialized row (no version: overlay rows have none yet). */
export interface LocalRow {
  readonly id: RowId;
  readonly value: unknown;
}

/**
 * A local-view change. `Patch` carries per-row confirmed deltas (emitted only
 * when the journal is empty, so they equal the materialized-view deltas) and
 * drives incremental `LiveView` maintenance. `Rebuild` is the conservative
 * fallback when the optimistic overlay shifts (a journal append/trim can affect
 * any collection), so observers re-materialize.
 */
type ViewChange =
  | { readonly _tag: "Patch"; readonly ops: ReadonlyArray<PatchOp> }
  | { readonly _tag: "Rebuild" };

const REBUILD: ViewChange = { _tag: "Rebuild" };

export interface ClientEngineOptions {
  readonly clientId: string;
  readonly clientGroupId: string;
  readonly mutators: MutatorRegistry;
  /** Named queries: client-side subset factories for local rendering. */
  readonly queries?: Query.QueryRegistry;
}

export interface ClientEngine {
  /**
   * Run a mutator optimistically and journal it for push. Args are
   * validated against the mutator's schema and journaled in encoded
   * (wire/persistence) form; handlers always receive decoded args.
   */
  readonly mutate: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<void, MutatorError | StoreError>;
  /**
   * Run a mutator whose args are already in encoded (wire) form — the
   * entry point for remote surfaces (tab mirrors, devtools) forwarding
   * mutations over a carrier. Args are validated by decoding.
   */
  readonly mutateEncoded: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<void, MutatorError | StoreError>;
  /** Register/replace the engine's subscriptions (synced on next pull). */
  readonly subscribe: (subset: Subset.Subset) => Effect.Effect<void>;
  readonly unsubscribe: (subset: Subset.Subset) => Effect.Effect<void>;
  /**
   * Subscribe a named query (Query.ts): the server resolves it to the
   * authoritative subset it syncs; the client renders it locally with its own
   * subset factory. Synced on the next pull.
   */
  readonly subscribeQuery: (name: string, args: unknown) => Effect.Effect<void, QueryError>;
  readonly unsubscribeQuery: (name: string, args: unknown) => Effect.Effect<void, QueryError>;
  /** Query a named query's local result (confirmed + overlay). */
  readonly queryNamed: (
    name: string,
    args: unknown
  ) => Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError | QueryError>;
  /** Live named query: re-emits on every local change. */
  readonly observeNamed: (
    name: string,
    args: unknown
  ) => Stream.Stream<ReadonlyArray<LocalRow>, StoreError | MutatorError | QueryError>;
  /** Query the current local view (confirmed + overlay). */
  readonly query: (
    subset: Subset.Subset
  ) => Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError>;
  /** Live query: emits the result now and after every local change. */
  readonly observe: (
    subset: Subset.Subset
  ) => Stream.Stream<ReadonlyArray<LocalRow>, StoreError | MutatorError>;
  /** Push pending mutations now. */
  readonly push: Effect.Effect<void, TransportError | StoreError>;
  /** Pull a patch now and rebase. */
  readonly pull: Effect.Effect<void, TransportError | StoreError | MutatorError>;
  /** Run the sync loop: pull on poke; push+pull on reconnect. */
  readonly runSync: Effect.Effect<void, TransportError | StoreError | MutatorError, Scope.Scope>;
}

export const ClientEngine = Context.Service<ClientEngine>("@legation/effect/ClientEngine");

export const make = (
  options: ClientEngineOptions
): Effect.Effect<ClientEngine, never, ClientStore | ClientTransport | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* ClientStore;
    const transport = yield* ClientTransport;
    const subscriptions = yield* Ref.make<ReadonlyArray<Subset.Subset>>([]);
    const namedSubs = yield* Ref.make<
      ReadonlyArray<{ readonly name: string; readonly argsEncoded: unknown; readonly key: string }>
    >([]);
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<ViewChange>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const publishChange = (change: ViewChange) => Effect.asVoid(PubSub.publish(changes, change));

    /** Confirmed rows + pending mutations replayed on top (the overlay). */
    const materialize: Effect.Effect<
      Map<string, Map<RowId, LocalRow>>,
      StoreError | MutatorError
    > = Effect.gen(function* () {
      const view = new Map<string, Map<RowId, LocalRow>>();
      const seeded = new Set<string>();

      const collectionView = (collection: string) => {
        const existing = view.get(collection);
        if (existing !== undefined) return Effect.succeed(existing);
        return Effect.gen(function* () {
          const created = new Map<RowId, LocalRow>();
          if (!seeded.has(collection)) {
            seeded.add(collection);
            for (const row of yield* store.listRows(collection)) {
              created.set(row.id, { id: row.id, value: row.value });
            }
          }
          view.set(collection, created);
          return created;
        });
      };

      const writer: LocalWriter = {
        put: (collection, id, value) =>
          collectionView(collection).pipe(
            Effect.map((rows) => {
              rows.set(id, { id, value });
            })
          ),
        del: (collection, id) =>
          collectionView(collection).pipe(
            Effect.map((rows) => {
              rows.delete(id);
            })
          ),
        get: (collection, id) =>
          collectionView(collection).pipe(Effect.map((rows) => rows.get(id)?.value)),
      };

      // Seed every collection we know about lazily via collectionView; then
      // replay pending mutations in journal order. Journal args are encoded
      // (they survive persistence and the wire), so decode before replay.
      for (const mutation of yield* store.pendingMutations) {
        const definition = options.mutators.mutators.get(mutation.mutator);
        const handler = options.mutators.handlers.get(mutation.mutator);
        if (definition === undefined || handler === undefined) {
          return yield* new MutatorError({
            message: `Unknown mutator: ${mutation.mutator}`,
            mutator: mutation.mutator,
          });
        }
        const args = yield* Schema.decodeUnknownEffect(definition.args)(mutation.args).pipe(
          Effect.mapError(
            (cause) =>
              new MutatorError({
                message: `Invalid journaled args for mutator "${mutation.mutator}"`,
                mutator: mutation.mutator,
                cause,
              })
          )
        );
        yield* handler(args, writer);
      }
      return view;
    });

    // All local rows of a collection (confirmed + overlay), loading confirmed
    // rows the overlay didn't already touch.
    const ensureCollection = (
      view: Map<string, Map<RowId, LocalRow>>,
      collection: string
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError> =>
      Effect.gen(function* () {
        const existing = view.get(collection);
        if (existing !== undefined) return [...existing.values()];
        const rows = new Map<RowId, LocalRow>();
        for (const row of yield* store.listRows(collection)) {
          rows.set(row.id, { id: row.id, value: row.value });
        }
        view.set(collection, rows);
        return [...rows.values()];
      });

    const collectionRows = (collection: string) =>
      materialize.pipe(Effect.flatMap((view) => ensureCollection(view, collection)));

    const query = (subset: Subset.Subset) =>
      collectionRows(subset.collection).pipe(Effect.map((rows) => Subset.apply(rows, subset)));

    const applyPatch = (ops: ReadonlyArray<PatchOp>): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        for (const op of ops) {
          switch (op._tag) {
            case "Clear":
              yield* store.clearRows;
              break;
            case "Put":
              yield* store.putRow(op.collection, {
                id: op.id,
                version: op.version,
                value: op.value,
              });
              break;
            case "Del":
              yield* store.delRow(op.collection, op.id);
              break;
          }
        }
      });

    const acknowledge = (lastMutationIds: Readonly<Record<string, number>>) =>
      Effect.gen(function* () {
        for (const [clientId, upTo] of Object.entries(lastMutationIds)) {
          yield* store.acknowledge(clientId, upTo);
        }
      });

    const push: ClientEngine["push"] = Effect.gen(function* () {
      const pending = yield* store.pendingMutations;
      if (pending.length === 0) return;
      const response = yield* transport.push({
        clientGroupId: options.clientGroupId,
        mutations: pending,
      });
      // Effects arrive via the next pull; the ack only trims the journal.
      yield* acknowledge(response.lastMutationIds);
      yield* publishChange(REBUILD); // trimming the overlay can shift any collection
      yield* Metric.update(Telemetry.mutationsPushedTotal, pending.length);
      yield* Metric.update(Telemetry.pushesTotal, 1);
    }).pipe(Effect.withSpan(Telemetry.span.clientPush));

    const applyPull = (response: PullResponse): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        // With an empty journal the patch ops are exactly the materialized-view
        // deltas, so observers maintain incrementally; with a pending overlay (or
        // a reset) the overlay could shift any row, so fall back to a rebuild.
        const hadPending = (yield* store.pendingMutations).length > 0;
        const hasClear = response.patch.some((op) => op._tag === "Clear");
        yield* applyPatch(response.patch);
        yield* acknowledge(response.lastMutationIds);
        yield* store.setCookie(response.cookie);
        // Atomic reveal: one change event after patch + ack (rebase is
        // recomputation in `materialize`).
        yield* publishChange(
          hadPending || hasClear ? REBUILD : { _tag: "Patch", ops: response.patch }
        );
      });

    const pull: ClientEngine["pull"] = Effect.gen(function* () {
      const cookie = yield* store.getCookie;
      const subsets = yield* Ref.get(subscriptions);
      const named = yield* Ref.get(namedSubs);
      const namedSubscriptions: ReadonlyArray<NamedSubscription> = named.map((entry) => ({
        name: entry.name,
        args: entry.argsEncoded,
      }));
      const response = yield* transport.pull({
        clientGroupId: options.clientGroupId,
        cookie,
        subscriptions: subsets,
        ...(namedSubscriptions.length > 0 ? { namedSubscriptions } : {}),
      });
      yield* applyPull(response);
      yield* Metric.update(Telemetry.pullsTotal, 1);
    }).pipe(Effect.withSpan(Telemetry.span.clientPull));

    const runSync: ClientEngine["runSync"] = Effect.gen(function* () {
      // Pull on every poke.
      yield* Effect.forkScoped(Stream.runForEach(transport.pokes, () => Effect.ignore(pull)));
      // Push + pull on (re)connect.
      yield* Effect.forkScoped(
        Stream.runForEach(transport.statusChanges, (status) =>
          status === "connected" ? Effect.ignore(push.pipe(Effect.andThen(pull))) : Effect.void
        )
      );
    });

    const definitionOf = (mutator: string) => {
      const definition = options.mutators.mutators.get(mutator);
      return definition === undefined || !options.mutators.handlers.has(mutator)
        ? Effect.fail(new MutatorError({ message: `Unknown mutator: ${mutator}`, mutator }))
        : Effect.succeed(definition);
    };

    // Named queries: resolve a name to its client-side definition + subset.
    const queryDefOf = (
      name: string
    ): Effect.Effect<
      { readonly definition: Query.AnyQuery; readonly local: Query.LocalQuery<any> },
      QueryError
    > => {
      const definition = options.queries?.queries.get(name);
      const local = options.queries?.locals.get(name);
      return definition === undefined || local === undefined
        ? Effect.fail(new QueryError({ message: `Unknown query: ${name}`, query: name }))
        : Effect.succeed({ definition, local });
    };
    const localSubsetOf = (name: string, args: unknown): Effect.Effect<Subset.Subset, QueryError> =>
      queryDefOf(name).pipe(Effect.map(({ local }) => local(args)));
    const encodeQueryArgs = (name: string, args: unknown): Effect.Effect<unknown, QueryError> =>
      queryDefOf(name).pipe(
        Effect.flatMap(({ definition }) =>
          Schema.encodeUnknownEffect(definition.args)(args).pipe(
            Effect.mapError(
              (cause) =>
                new QueryError({ message: `Invalid args for query "${name}"`, query: name, cause })
            )
          )
        )
      );
    const namedKey = (name: string, argsEncoded: unknown) =>
      `${name}:${JSON.stringify(argsEncoded)}`;
    // Encode + key a named subscription, then update the registry with both.
    const updateNamedSubs = (
      name: string,
      args: unknown,
      update: (
        current: ReadonlyArray<{ name: string; argsEncoded: unknown; key: string }>,
        entry: { name: string; argsEncoded: unknown; key: string }
      ) => ReadonlyArray<{ name: string; argsEncoded: unknown; key: string }>
    ): Effect.Effect<void, QueryError> =>
      encodeQueryArgs(name, args).pipe(
        Effect.flatMap((argsEncoded) =>
          Ref.update(namedSubs, (current) =>
            update(current, { name, argsEncoded, key: namedKey(name, argsEncoded) })
          )
        )
      );
    // Apply a Patch's confirmed deltas for one collection to a LiveView.
    const applyOps = (
      view: LiveView.LiveView,
      collection: string,
      ops: ReadonlyArray<PatchOp>
    ): LiveView.LiveView => {
      let next = view;
      for (const op of ops) {
        if (op._tag === "Clear" || op.collection !== collection) continue;
        next =
          op._tag === "Put"
            ? LiveView.put(next, { id: op.id, value: op.value })
            : LiveView.del(next, op.id);
      }
      return next;
    };

    const sameResult = (a: ReadonlyArray<LocalRow>, b: ReadonlyArray<LocalRow>): boolean =>
      a.length === b.length &&
      a.every((row, i) => row.id === b[i]!.id && row.value === b[i]!.value);

    // Advance a query's LiveView for one change and return its current page.
    const stepView = (
      viewRef: Ref.Ref<LiveView.LiveView>,
      subset: Subset.Subset,
      change: ViewChange
    ): Effect.Effect<ReadonlyArray<LocalRow>, StoreError | MutatorError> =>
      Effect.gen(function* () {
        const view = yield* Ref.get(viewRef);
        const next =
          change._tag === "Rebuild"
            ? LiveView.make(subset, yield* collectionRows(subset.collection))
            : applyOps(view, subset.collection, change.ops);
        if (next !== view) yield* Ref.set(viewRef, next);
        return LiveView.result(next);
      });

    const observeSubset = (subset: Subset.Subset) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const viewRef = yield* Ref.make(
            LiveView.make(subset, yield* collectionRows(subset.collection))
          );
          const initial = LiveView.result(yield* Ref.get(viewRef));
          // Emit the page on each change, dropping re-emits when it didn't move
          // (e.g. a change outside the limit window).
          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromPubSub(changes).pipe(
              Stream.mapEffect((change) => stepView(viewRef, subset, change))
            )
          ).pipe(Stream.changesWith(sameResult));
        })
      );
    const invalidArgs = (mutator: string) => (cause: unknown) =>
      new MutatorError({ message: `Invalid args for mutator "${mutator}"`, mutator, cause });
    const journal = (mutator: string, encoded: unknown) =>
      Effect.gen(function* () {
        const mutationId = yield* store.nextMutationId(options.clientId);
        const mutation: Mutation = {
          clientId: options.clientId,
          mutationId,
          mutator,
          args: encoded,
          createdAt: yield* Clock.currentTimeMillis,
        };
        yield* store.appendMutation(mutation);
        yield* publishChange(REBUILD); // the mutation may write any collection
      });

    return ClientEngine.of({
      mutate: (mutator, args) =>
        Effect.gen(function* () {
          const definition = yield* definitionOf(mutator);
          // Validate now (fail fast at the call site). Callers pass the
          // decoded Type; encoding it validates and produces the journal's
          // wire/persistence form.
          const encoded = yield* Schema.encodeUnknownEffect(definition.args)(args).pipe(
            Effect.mapError(invalidArgs(mutator))
          );
          yield* journal(mutator, encoded);
        }),
      mutateEncoded: (mutator, args) =>
        Effect.gen(function* () {
          const definition = yield* definitionOf(mutator);
          // Decoding validates the encoded form; the journal keeps it as-is.
          yield* Schema.decodeUnknownEffect(definition.args)(args).pipe(
            Effect.mapError(invalidArgs(mutator))
          );
          yield* journal(mutator, args);
        }),
      subscribe: (subset) =>
        Ref.update(subscriptions, (current) =>
          current.some((s) => Subset.hash(s) === Subset.hash(subset))
            ? current
            : [...current, subset]
        ),
      unsubscribe: (subset) =>
        Ref.update(subscriptions, (current) =>
          current.filter((s) => Subset.hash(s) !== Subset.hash(subset))
        ),
      subscribeQuery: (name, args) =>
        updateNamedSubs(name, args, (current, entry) =>
          current.some((e) => e.key === entry.key) ? current : [...current, entry]
        ).pipe(Effect.andThen(publishChange(REBUILD))),
      unsubscribeQuery: (name, args) =>
        updateNamedSubs(name, args, (current, entry) => current.filter((e) => e.key !== entry.key)),
      query,
      queryNamed: (name, args) => localSubsetOf(name, args).pipe(Effect.flatMap(query)),
      observe: observeSubset,
      observeNamed: (name, args) =>
        Stream.unwrap(localSubsetOf(name, args).pipe(Effect.map(observeSubset))),
      push,
      pull,
      runSync,
    });
  });

/** Layer building the engine from ClientStore + ClientTransport. */
export const layer = (
  options: ClientEngineOptions
): Layer.Layer<ClientEngine, never, ClientStore | ClientTransport> =>
  Layer.effect(ClientEngine)(make(options));
