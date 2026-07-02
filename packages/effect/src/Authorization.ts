/**
 * Authorization
 *
 * Read authorization for collection-subset subscriptions: deny by default.
 * Every collection a server exposes must declare an auth filter — a
 * function from the request's SyncContext to a predicate that is AND-ed
 * into every client subscription before evaluation, so client predicates
 * can only narrow the authorized set. Write authorization is plain code
 * inside backend mutators.
 *
 * Cross-cutting concerns (tenancy, cost control, telemetry) attach via
 * SyncMiddleware, which can rewrite or reject requests around the core
 * push/pull handling.
 */

import { Context, Effect } from "effect";
import { AuthorizationError } from "./Errors.js";
import type { SyncContext } from "./Backend.js";
import type { Predicate } from "./Predicate.js";
import * as Predicates from "./Predicate.js";
import type { PullRequest, PushRequest } from "./Protocol.js";
import type { Subset } from "./Subset.js";

/** Produce the mandatory predicate for a collection, per request. */
export type AuthFilter = (context: SyncContext) => Effect.Effect<Predicate, AuthorizationError>;

/** Allow every row (public collection) — must be opted into explicitly. */
export const allowAll: AuthFilter = () => Effect.succeed(Predicates.always);

/** Per-collection auth filters. Subscribing to an unlisted collection fails. */
export interface AuthPolicy {
  readonly filters: ReadonlyMap<string, AuthFilter>;
}

export const AuthPolicy = Context.Service<AuthPolicy>("@legation/effect/AuthPolicy");

export const policy = (filters: Readonly<Record<string, AuthFilter>>): AuthPolicy => ({
  filters: new Map(Object.entries(filters)),
});

/** Narrow a subset with its collection's auth filter (deny by default). */
export const authorize = (
  authPolicy: AuthPolicy,
  context: SyncContext,
  subset: Subset
): Effect.Effect<Subset, AuthorizationError> => {
  const filter = authPolicy.filters.get(subset.collection);
  if (filter === undefined) {
    return Effect.fail(
      new AuthorizationError({
        message: `No auth filter declared for collection "${subset.collection}" (deny by default)`,
        collection: subset.collection,
      })
    );
  }
  return filter(context).pipe(
    Effect.map((mandatory) => ({ ...subset, where: Predicates.and(mandatory, subset.where) }))
  );
};

/** Interception seam around push/pull handling. */
export interface SyncMiddleware {
  readonly onPush: (
    context: SyncContext,
    request: PushRequest
  ) => Effect.Effect<PushRequest, AuthorizationError>;
  readonly onPull: (
    context: SyncContext,
    request: PullRequest
  ) => Effect.Effect<PullRequest, AuthorizationError>;
}

export const SyncMiddleware = Context.Service<SyncMiddleware>("@legation/effect/SyncMiddleware");

/** The identity middleware (no interception). */
export const passthroughMiddleware: SyncMiddleware = {
  onPush: (_context, request) => Effect.succeed(request),
  onPull: (_context, request) => Effect.succeed(request),
};

/**
 * Resolve the request's identity for a connected client group — the decoded,
 * never-client-forgeable principal the auth filters and middleware see on
 * `SyncContext.identity`. A real carrier derives it from the authenticated
 * connection (a verified token); the resolver is the seam where that lands.
 * Optional: absent ⇒ `identity` stays `undefined` (public/deny-by-default).
 */
export interface IdentityResolver {
  readonly resolve: (clientGroupId: string) => Effect.Effect<unknown, AuthorizationError>;
}

export const IdentityResolver = Context.Service<IdentityResolver>(
  "@legation/effect/IdentityResolver"
);
