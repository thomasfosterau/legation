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

import { Context, Effect, Layer, PubSub, Ref, Schema, Scope, Stream } from "effect";
import type { RowId } from "./Collection.js";
import { ClientStore } from "./ClientStore.js";
import { MutatorError, StoreError, TransportError } from "./Errors.js";
import type { LocalWriter, MutatorRegistry } from "./Mutator.js";
import type { Mutation, PatchOp, PullResponse } from "./Protocol.js";
import { ClientTransport } from "./Transport.js";
import * as Subset from "./Subset.js";

/** A locally-materialized row (no version: overlay rows have none yet). */
export interface LocalRow {
  readonly id: RowId;
  readonly value: unknown;
}

export interface ClientEngineOptions {
  readonly clientId: string;
  readonly clientGroupId: string;
  readonly mutators: MutatorRegistry;
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
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const publishChange = Effect.asVoid(PubSub.publish(changes, undefined));

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
      yield* publishChange;
    });

    const applyPull = (response: PullResponse): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        yield* applyPatch(response.patch);
        yield* acknowledge(response.lastMutationIds);
        yield* store.setCookie(response.cookie);
        // Atomic reveal: one change event after patch + ack (rebase is
        // recomputation in `materialize`).
        yield* publishChange;
      });

    const pull: ClientEngine["pull"] = Effect.gen(function* () {
      const cookie = yield* store.getCookie;
      const subsets = yield* Ref.get(subscriptions);
      const response = yield* transport.pull({
        clientGroupId: options.clientGroupId,
        cookie,
        subscriptions: subsets,
      });
      yield* applyPull(response);
    });

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
        yield* publishChange;
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
      query,
      observe: (subset) =>
        Stream.concat(
          Stream.fromEffect(query(subset)),
          Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => query(subset)))
        ),
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
