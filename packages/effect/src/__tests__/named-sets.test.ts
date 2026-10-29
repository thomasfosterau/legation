/**
 * Session-resolved read scopes (#205, ADR-0015's amendment): an auth filter's
 * three-way `ReadScope`, named sets bound per session, and the scope epoch in
 * the CVR cookie. The scope is Gardeneria's owned-leaf rule, as one declaration
 * per collection:
 *
 *   moderator → AllowAll
 *   anonymous → visibility = 'public'
 *   member    → public OR ownerId = viewer OR
 *               (visibility = 'followers' AND ownerId IN set(followingIds))
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as Cvr from "../Cvr.js";
import { AuthorizationError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import type { PatchOp, PullResponse } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";

interface Post {
  readonly id: string;
  readonly ownerId: string;
  readonly visibility: "public" | "followers" | "private";
}

const Follow = Schema.Struct({
  id: Schema.String,
  follower: Schema.String,
  followee: Schema.String,
});
const decodeFollow = Schema.decodeUnknownOption(Follow);

const Identity = Schema.Struct({ user: Schema.optional(Schema.String), role: Schema.String });

/** clientGroupId → identity (a real carrier derives it from a verified token). */
const identities = {
  "group-switch": { user: "alice", role: "member" },
  "group-mod": { user: "mod", role: "moderator" },
  "group-alice": { user: "alice", role: "member" },
  "group-anon": { role: "anonymous" },
  "group-broken": { user: "broken", role: "member" },
} satisfies Record<string, typeof Identity.Type>;

/** The identities by any client group id: an unknown group has none. */
const identityTable: R.ReadonlyRecord<string, typeof Identity.Type> = identities;

const identityOf = (context: { readonly identity?: unknown }) =>
  Schema.decodeUnknownOption(Identity)(context.identity);

/** Builds the scope over a backend: `followingIds` reads the follows collection. */
const policyOver = (backend: Backend, source: string, gate: Effect.Effect<void> = Effect.void) => {
  const followingIds: Authorization.NamedSet = {
    source,
    maxAge: "1 hour",
    resolve: (context) => {
      const user = Option.getOrUndefined(
        Option.flatMapNullishOr(identityOf(context), (identity) => identity.user)
      );
      if (user === undefined || user === "broken") {
        return Effect.fail(
          new AuthorizationError({ message: "cannot resolve following", collection: "posts" })
        );
      }
      return Effect.gen(function* () {
        const entries = yield* backend.evaluate(
          context,
          Subset.make({ collection: "follows", where: Predicate.eq("follower", user) })
        );
        const rows = yield* backend.getRows(
          context,
          "follows",
          entries.map((entry) => entry.id)
        );
        return rows.flatMap((row) =>
          Option.toArray(decodeFollow(row.value)).map((follow) => follow.followee)
        );
      }).pipe(
        Effect.orDie,
        Effect.tap(() => gate)
      );
    },
  };
  const posts: Authorization.AuthFilter = (context) => {
    const decoded = identityOf(context);
    if (Option.isNone(decoded)) return Effect.succeed(Authorization.Deny);
    const identity = decoded.value;
    if (identity.role === "moderator") return Effect.succeed(Authorization.AllowAll);
    const isPublic = Predicate.eq("visibility", "public");
    if (identity.role === "anonymous" || identity.user === undefined) {
      return Effect.succeed(Authorization.filter(isPublic));
    }
    return Effect.succeed(
      Authorization.filter(
        Predicate.or(
          isPublic,
          Predicate.eq("ownerId", identity.user),
          Predicate.and(
            Predicate.eq("visibility", "followers"),
            Predicate.inSet("ownerId", "followingIds")
          )
        ),
        { followingIds }
      )
    );
  };
  return Authorization.policy({ posts, follows: Authorization.allowAll });
};

const PutArgs = Schema.Struct({
  collection: Schema.String,
  value: Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
});
type Put = typeof PutArgs.Type;
const putRow = Mutator.make("put", PutArgs);

const put = (collection: string, value: Put["value"]): Put => ({ collection, value });

const handlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(putRow, ({ collection, value }, writer) =>
    writer.put(collection, value.id, value)
  ),
]);

const seed: ReadonlyArray<Put> = [
  put("posts", { id: "pub", ownerId: "bob", visibility: "public" } satisfies Post),
  put("posts", { id: "bob-followers", ownerId: "bob", visibility: "followers" } satisfies Post),
  put("posts", { id: "bob-private", ownerId: "bob", visibility: "private" } satisfies Post),
  put("posts", { id: "alice-private", ownerId: "alice", visibility: "private" } satisfies Post),
];

const setupWith = (
  source: string,
  policy?: (backend: Backend) => Authorization.AuthPolicy,
  options?: SyncServer.SyncServerOptions
) =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(handlers);
    const server = yield* SyncServer.makeWith(options).pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        policy === undefined ? policyOver(backend, source) : policy(backend)
      ),
      Effect.provideService(Authorization.IdentityResolver, {
        resolve: (clientGroupId) =>
          Effect.succeed(Option.getOrUndefined(R.get(identityTable, clientGroupId))),
      }),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
    let mutationId = 0;
    const write = (value: Put) =>
      server.handlePush({
        clientGroupId: "group-writer",
        mutations: [
          {
            clientId: "writer",
            mutationId: ++mutationId,
            mutator: "put",
            args: value,
            createdAt: 0,
          },
        ],
      });
    yield* Effect.forEach(seed, write, { concurrency: 1, discard: true });
    const pull = (clientGroupId: string, cookie?: string, ...collections: Array<string>) => {
      const request = {
        clientGroupId,
        subscriptions: (Arr.isReadonlyArrayEmpty(collections) ? ["posts"] : collections).map(
          (collection) => Subset.make({ collection })
        ),
      };
      return server.handlePull(cookie === undefined ? request : { ...request, cookie });
    };
    return { server, write, pull };
  });

const setup = setupWith("follows");

/** A named set over the follows source with fixed members. */
const setOf = (members: ReadonlyArray<string>): Authorization.NamedSet => ({
  source: "follows",
  maxAge: "1 hour",
  resolve: () => Effect.succeed(members),
});

const putIds = (response: PullResponse) =>
  response.patch.flatMap((op: PatchOp) => (P.isTagged(op, "Put") ? [op.id] : [])).toSorted();

describe("session-resolved read scopes (#205)", () => {
  it.effect("expresses the multi-tenant scope as one declaration per collection", () =>
    Effect.gen(function* () {
      const { pull, write } = yield* setup;
      yield* write(put("follows", { id: "f1", follower: "alice", followee: "bob" }));
      expect(putIds(yield* pull("group-mod"))).toEqual([
        "alice-private",
        "bob-followers",
        "bob-private",
        "pub",
      ]);
      expect(putIds(yield* pull("group-anon"))).toEqual(["pub"]);
      expect(putIds(yield* pull("group-alice"))).toEqual(["alice-private", "bob-followers", "pub"]);
    })
  );

  it.effect("gains rows when the session's set changes, with no write to the collection", () =>
    Effect.gen(function* () {
      const { pull, write } = yield* setup;
      const first = yield* pull("group-alice");
      expect(putIds(first)).toEqual(["alice-private", "pub"]);

      // A write to the set's source only: no post changes. The fan-out marks the
      // session's set stale and pokes it; the session pulls until the poke has
      // been handled (the hint is delivered asynchronously).
      yield* write(put("follows", { id: "f1", follower: "alice", followee: "bob" }));
      const pullUntilChanged = (attempt: number): Effect.Effect<PullResponse, unknown> =>
        pull("group-alice", first.cookie).pipe(
          Effect.flatMap((response) =>
            Arr.isReadonlyArrayNonEmpty(response.patch) || attempt >= 100
              ? Effect.succeed(response)
              : Effect.yieldNow.pipe(Effect.andThen(pullUntilChanged(attempt + 1)))
          )
        );
      const second = yield* pullUntilChanged(1);
      // The epoch moved, so the pull took the reset path.
      expect(second.patch[0]?._tag).toBe("Clear");
      expect(putIds(second)).toEqual(["alice-private", "bob-followers", "pub"]);
      expect(second.cookie).not.toBe(first.cookie);
    })
  );

  it.effect("resolves again after a write that overlapped the set's resolution", () =>
    Effect.gen(function* () {
      // The resolver reads the members, then waits; the write to the source lands
      // and its hint is handled before the resolution is cached. The cached
      // members predate the write, so the next pull must not trust them.
      const gate = yield* Deferred.make<void>();
      const { pull, write } = yield* setupWith("follows", (backend) =>
        policyOver(backend, "follows", Deferred.await(gate))
      );
      const settle = Effect.forEach(Arr.range(1, 100), () => Effect.yieldNow, {
        concurrency: 1,
        discard: true,
      });
      const inFlight = yield* Effect.forkChild(pull("group-alice"));
      yield* settle;
      yield* write(put("follows", { id: "f1", follower: "alice", followee: "bob" }));
      yield* settle;
      yield* Deferred.succeed(gate, undefined);
      const first = yield* Fiber.join(inFlight);
      expect(putIds(first)).toEqual(["alice-private", "pub"]);
      const second = yield* pull("group-alice", first.cookie);
      expect(putIds(second)).toEqual(["alice-private", "bob-followers", "pub"]);
    })
  );

  it.effect("diffs as usual while the set stays the same", () =>
    Effect.gen(function* () {
      const { pull } = yield* setup;
      const first = yield* pull("group-alice");
      const second = yield* pull("group-alice", first.cookie);
      expect(second.patch).toEqual([]);
    })
  );

  it.effect("reads no epoch out of a fleet namespace that contains its separator", () =>
    Effect.gen(function* () {
      // The anonymous scope binds no set, so its cookie carries no epoch; a `~e`
      // inside the namespace must not be read as one, or every pull would reset.
      const { pull } = yield* setupWith("follows", undefined, { cookieNamespace: "deploy~e1" });
      const first = yield* pull("group-anon");
      const second = yield* pull("group-anon", first.cookie);
      expect(second.patch).toEqual([]);
    })
  );

  it.effect("binds an unresolvable set to nothing: it narrows, never widens", () =>
    Effect.gen(function* () {
      const { pull, write } = yield* setup;
      yield* write(put("follows", { id: "f1", follower: "broken", followee: "bob" }));
      yield* write(put("posts", { id: "broken-own", ownerId: "broken", visibility: "private" }));
      // The followers branch admits nothing; the other branches still apply.
      expect(putIds(yield* pull("group-broken"))).toEqual(["broken-own", "pub"]);
    })
  );

  it.effect("binds a set the scope does not declare to nothing", () =>
    Effect.gen(function* () {
      const scope = Authorization.filter(Predicate.inSet("ownerId", "undeclared"));
      const authorized = yield* Authorization.authorize(
        Authorization.policy({ posts: () => Effect.succeed(scope) }),
        { clientGroupId: "g" },
        Subset.make({ collection: "posts" }),
        "server"
      );
      expect(Predicate.test(authorized.where, { ownerId: "bob" })).toBe(false);
    })
  );

  it.effect("keeps an undeclared collection unreachable, whatever the role", () =>
    Effect.gen(function* () {
      const { pull } = yield* setup;
      const error = yield* Effect.flip(pull("group-mod", undefined, "secrets"));
      expect(error.message).toContain('No auth filter declared for collection "secrets"');
    })
  );

  it.effect("denies every row for a Deny scope", () =>
    Effect.gen(function* () {
      const { pull } = yield* setup;
      expect(putIds(yield* pull("group-nobody"))).toEqual([]);
    })
  );

  it.effect("resolves a set again past its maxAge, even when no hint marked it stale", () =>
    Effect.gen(function* () {
      // The set names another source, so the write to follows never marks it.
      const { pull, write } = yield* setupWith("profiles");
      const first = yield* pull("group-alice");
      yield* write(put("follows", { id: "f1", follower: "alice", followee: "bob" }));
      const fresh = yield* pull("group-alice", first.cookie);
      expect(fresh.patch).toEqual([]);

      yield* TestClock.adjust("2 hours");
      const expired = yield* pull("group-alice", fresh.cookie);
      expect(expired.patch[0]?._tag).toBe("Clear");
      expect(putIds(expired)).toEqual(["alice-private", "bob-followers", "pub"]);
    })
  );

  it.effect("never serves a set resolved for the group's previous identity", () =>
    Effect.gen(function* () {
      const { pull, write } = yield* setup;
      yield* write(put("follows", { id: "f1", follower: "alice", followee: "bob" }));
      const asAlice = yield* pull("group-switch");
      expect(putIds(asAlice)).toEqual(["alice-private", "bob-followers", "pub"]);

      // The same client group now resolves to another user, within the set's
      // maxAge and with no write to its source.
      identities["group-switch"] = { user: "carol", role: "member" };
      const asCarol = yield* pull("group-switch", asAlice.cookie);
      expect(asCarol.patch[0]?._tag).toBe("Clear");
      expect(putIds(asCarol)).toEqual(["pub"]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          identities["group-switch"] = { user: "alice", role: "member" };
        })
      )
    )
  );

  it.effect("keeps two collections' sets of one name apart", () =>
    Effect.gen(function* () {
      const { pull, write } = yield* setupWith("follows", () =>
        Authorization.policy({
          posts: () =>
            Effect.succeed(
              Authorization.filter(Predicate.inSet("ownerId", "ids"), { ids: setOf(["bob"]) })
            ),
          notes: () =>
            Effect.succeed(
              Authorization.filter(Predicate.inSet("ownerId", "ids"), { ids: setOf(["alice"]) })
            ),
        })
      );
      yield* write(put("notes", { id: "note-alice", ownerId: "alice" }));
      yield* write(put("notes", { id: "note-bob", ownerId: "bob" }));
      const response = yield* pull("group-alice", undefined, "posts", "notes");
      expect(putIds(response)).toEqual(["bob-followers", "bob-private", "note-alice", "pub"]);
    })
  );
});
