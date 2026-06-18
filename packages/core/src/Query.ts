/**
 * Query
 *
 * Named queries: a query defined once and resolved twice — like a mutator, but
 * for reads. The client resolves a name + args to a `Subset` to render locally;
 * the server resolves the same name + args to the *authoritative* `Subset` it
 * will sync, with the request's identity in hand. The two may differ: the
 * server narrows (a tenant scope, an ownership filter, a join the client can't
 * express), putting query shaping and permission on the server (ADR-0009's
 * "what only the app can know"), while the client still renders from the rows
 * it was sent.
 *
 * A client subscribes by name + args (Protocol's `namedSubscriptions`); the
 * server's `QueryResolver` turns each into a Subset, which is then authorized
 * and evaluated exactly like a client-authored subscription.
 */

import { Context, Effect, Schema } from "effect";
import type { SyncContext } from "./Backend.js";
import { AuthorizationError, DuplicateNameError, QueryError } from "./Errors.js";
import type { Subset } from "./Subset.js";

/** A named query definition: the shared, serializable contract (name + args). */
export interface Query<Name extends string, Args, ArgsEncoded = unknown> {
  readonly name: Name;
  readonly args: Schema.Codec<Args, ArgsEncoded>;
}

export type AnyQuery = Query<string, any, any>;

/** Define a named query contract. */
export const make = <const Name extends string, Args, ArgsEncoded>(
  name: Name,
  args: Schema.Codec<Args, ArgsEncoded>
): Query<Name, Args, ArgsEncoded> => ({ name, args });

// ─── Client side ─────────────────────────────────────────────────────────────

/** Resolve a query's args to the subset the client renders locally. */
export type LocalQuery<Args> = (args: Args) => Subset;

/** Query definitions paired with their client-side subset factories. */
export interface QueryRegistry {
  readonly queries: ReadonlyMap<string, AnyQuery>;
  readonly locals: ReadonlyMap<string, LocalQuery<any>>;
}

/** Pair query definitions with client subset factories. Duplicate names throw. */
export const registry = (
  entries: ReadonlyArray<{ readonly query: AnyQuery; readonly local: LocalQuery<any> }>
): QueryRegistry => {
  const queries = new Map<string, AnyQuery>();
  const locals = new Map<string, LocalQuery<any>>();
  for (const { query, local } of entries) {
    if (queries.has(query.name)) throw new DuplicateNameError({ kind: "query", name: query.name });
    queries.set(query.name, query);
    locals.set(query.name, local);
  }
  return { queries, locals };
};

// ─── Server side ─────────────────────────────────────────────────────────────

/** Resolve a query's args + request identity to the authoritative subset. */
export type ServerQuery<Args> = (
  args: Args,
  context: SyncContext
) => Effect.Effect<Subset, AuthorizationError>;

/** Resolve a named subscription (name + encoded args) to a server subset. */
export interface QueryResolver {
  readonly resolve: (
    name: string,
    encodedArgs: unknown,
    context: SyncContext
  ) => Effect.Effect<Subset, AuthorizationError | QueryError>;
}

export const QueryResolver = Context.Service<QueryResolver>(
  "@thomasfosterau/effect-sync-core/QueryResolver"
);

/**
 * Build a server resolver from typed entries. Pushed args are untrusted, so
 * each is schema-validated before the server query runs; an unknown name is
 * denied (a `QueryError`).
 */
export const resolver = (
  entries: ReadonlyArray<{ readonly query: AnyQuery; readonly server: ServerQuery<any> }>
): QueryResolver => {
  const map = new Map(entries.map((entry) => [entry.query.name, entry] as const));
  return {
    resolve: (name, encodedArgs, context) => {
      const entry = map.get(name);
      if (entry === undefined) {
        return Effect.fail(new QueryError({ message: `Unknown query: ${name}`, query: name }));
      }
      return Schema.decodeUnknownEffect(entry.query.args)(encodedArgs).pipe(
        Effect.mapError(
          (cause) =>
            new QueryError({ message: `Invalid args for query "${name}"`, query: name, cause })
        ),
        Effect.flatMap((args) => entry.server(args, context))
      );
    },
  };
};
