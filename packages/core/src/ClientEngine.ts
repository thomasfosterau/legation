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

import { Context, Effect, Layer, Metric, PubSub, Ref, Schema, Scope, Stream } from "effect";
import type { RowId } from "./Collection.js";
import { ClientStore } from "./ClientStore.js";
import { MutatorError, QueryError, StoreError, TransportError } from "./Errors.js";
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

/** Which collections a local change touched, or every collection. */
type ChangeSet = typeof ALL | ReadonlyArray<string>;
const ALL = "all" as const;

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

export const ClientEngine = Context.Service<ClientEngine>(
  "@thomasfosterau/effect-sync-core/ClientEngine"
);

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
    // A change event names the collections it touched, so a live query
    // re-evaluates only when its collection changed (selective view
    // maintenance). `"all"` forces re-evaluation everywhere — used whenever the
    // optimistic overlay shifts (a journal append or trim can affect any
    // collection a pending mutation writes).
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<ChangeSet>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const publishChange = (change: ChangeSet) => Effect.asVoid(PubSub.publish(changes, change));
    const affects = (change: ChangeSet, collection: string): boolean =>
      change === ALL || change.includes(collection);
    const patchCollections = (ops: ReadonlyArray<PatchOp>): ChangeSet => {
      const collections = new Set<string>();
      for (const op of ops) {
        if (op._tag === "Clear") return ALL;
        collections.add(op.collection);
      }
      return [...collections];
    };

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

    const query = (subset: Subset.Subset) =>
      materialize.pipe(
        Effect.flatMap((view) =>
          Effect.gen(function* () {
            // Ensure confirmed rows for the queried collection are loaded
            // even when no pending mutation touched it.
            if (!view.has(subset.collection)) {
              const rows = new Map<RowId, LocalRow>();
              for (const row of yield* store.listRows(subset.collection)) {
                rows.set(row.id, { id: row.id, value: row.value });
              }
              view.set(subset.collection, rows);
            }
            return Subset.apply([...view.get(subset.collection)!.values()], subset);
          })
        )
      );

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
      yield* publishChange(ALL); // trimming the overlay can shift any collection
      yield* Metric.update(Telemetry.mutationsPushedTotal, pending.length);
      yield* Metric.update(Telemetry.pushesTotal, 1);
    }).pipe(Effect.withSpan(Telemetry.span.clientPush));

    const applyPull = (response: PullResponse): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        // With a pending overlay, acking can shift any collection a pending
        // mutation writes, so re-evaluate everything; with an empty journal the
        // pull only changes the patch's collections.
        const hadPending = (yield* store.pendingMutations).length > 0;
        yield* applyPatch(response.patch);
        yield* acknowledge(response.lastMutationIds);
        yield* store.setCookie(response.cookie);
        // Atomic reveal: one change event after patch + ack (rebase is
        // recomputation in `materialize`).
        yield* publishChange(hadPending ? ALL : patchCollections(response.patch));
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
    const observeSubset = (subset: Subset.Subset) =>
      Stream.concat(
        Stream.fromEffect(query(subset)),
        Stream.fromPubSub(changes).pipe(
          Stream.filter((change) => affects(change, subset.collection)),
          Stream.mapEffect(() => query(subset))
        )
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
          createdAt: Date.now(),
        };
        yield* store.appendMutation(mutation);
        yield* publishChange(ALL); // the mutation may write any collection
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
        ).pipe(Effect.andThen(publishChange(ALL))),
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
