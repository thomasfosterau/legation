/**
 * effect-auth read scopes as legation auth filters (#219 §2, §3): the
 * translation is its own tested function with typed failures and no throw;
 * field names are explicit and checked when the mapping is built; literals
 * are reconciled explicitly (instants as `Date#toISOString`); every failure
 * narrows to `Deny`; a privileged role short-circuits to `AllowAll`; an
 * undeclared collection stays unreachable; and a subscription's authored
 * scope is stable while a named set's members move.
 */
import { assert, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Condition, Entity, Policy, ReadScope as AuthScope } from "@thomasfosterau/effect-auth";
import {
  Authorization,
  AuthorizationError,
  Backend,
  MemoryBackend,
  Mutator,
  Predicate,
} from "@thomasfosterau/legation";
import { Cvr, InvalidationBus, Subset, SyncServer } from "@thomasfosterau/legation/internal";
import { Principal, ReadScopes } from "@thomasfosterau/legation-auth";
import { Crash, failureOf, mentions, orFail } from "./support.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const binding: AuthScope.Binding = {
  resourceType: "Post",
  attributes: {
    owner: { entity: "User" },
    visibility: "Text",
    publishedAt: "Instant",
    score: "Integer",
    rating: "Double",
    pinned: "Boolean",
  },
  setFacts: { followsOwner: { attribute: "owner", set: "following" } },
};

const attributes = {
  owner: "ownerId",
  visibility: "visibility",
  publishedAt: "publishedAt",
  score: "score",
  rating: "rating",
  pinned: "pinned",
};

const followingOf = (members: ReadonlyArray<string>): Authorization.NamedSet => ({
  source: "follows",
  maxAge: "1 hour",
  resolve: () => Effect.succeed(members),
});

const following = followingOf(["user-bob"]);

const checked = (sets: Readonly<Record<string, Authorization.NamedSet>> = { following }) =>
  orFail(ReadScopes.mapping({ collection: "posts", binding, attributes, sets: sets }));

const resource = (name: string) => Condition.attr("resource", name);

/** Public posts, the viewer's own, and followers-only posts of people they follow; admins read all. */
const policies: ReadonlyArray<Policy.DeclarativePolicy> = [
  Policy.permit({
    id: "public",
    resource: Policy.isType("Post"),
    when: Condition.eq(resource("visibility"), Condition.lit("public")),
  }),
  Policy.permit({
    id: "own",
    resource: Policy.isType("Post"),
    when: Condition.eq(resource("owner"), Condition.principal),
  }),
  Policy.permit({
    id: "followers",
    resource: Policy.isType("Post"),
    when: Condition.and(
      Condition.eq(resource("visibility"), Condition.lit("followers")),
      Condition.eq(Condition.attr("context", "followsOwner"), Condition.lit(true))
    ),
  }),
  Policy.role("admin", { id: "admin" }),
];

const slice = Entity.slice([
  Entity.entity(Entity.ref("User", "user-mod"), { parents: [Entity.ref("Role", "admin")] }),
]);

/** The effect-auth request for a principal: anonymous is `User::""`, which no policy names. */
const requestOf = (principal: Principal.Principal): AuthScope.ScopeRequest => ({
  principal: Entity.ref(
    "User",
    Option.getOrElse(Principal.userId(principal), () => "")
  ),
  action: Entity.ref("Action", "read"),
  slice,
});

const compile = ReadScopes.compiler({
  policies: () => Effect.succeed(policies),
  request: (principal) => Effect.succeed(requestOf(principal)),
});

const principalOf = (userId: string): Principal.Principal => ({
  _tag: "ApiKey",
  userId,
  keyId: `key-${userId}`,
  permissions: Option.none(),
});

const contextOf = (principal: Principal.Principal) => ({ clientGroupId: "g", identity: principal });

const filterOf = (scope: AuthScope.ReadScope): AuthScope.ReadScope => scope;

// ─── The mapping, checked when it is built ───────────────────────────────────

describe("ReadScopes.mapping: field names explicit and checked at registration", () => {
  it("builds a mapping that names every attribute and declares every set", () => {
    expect(
      Result.isSuccess(
        ReadScopes.mapping({
          collection: "posts",
          binding,
          attributes,
          sets: { following },
        })
      )
    ).toBe(true);
  });

  it("refuses an attribute with no row field", () => {
    const { owner: _owner, ...partial } = attributes;
    const error = failureOf(
      ReadScopes.mapping({
        collection: "posts",
        binding,
        attributes: partial,
        sets: { following },
      })
    );
    expect(error?.reason).toBe("UnmappedAttribute");
    expect(error?.message).toContain("owner");
  });

  it("refuses an empty row field", () => {
    const error = failureOf(
      ReadScopes.mapping({
        collection: "posts",
        binding,
        attributes: { ...attributes, score: "" },
        sets: { following },
      })
    );
    expect(error?.reason).toBe("UnmappedAttribute");
  });

  it("refuses a mapped attribute the binding does not declare", () => {
    const error = failureOf(
      ReadScopes.mapping({
        collection: "posts",
        binding,
        attributes: { ...attributes, title: "title" },
        sets: { following },
      })
    );
    expect(error?.reason).toBe("UnknownAttribute");
  });

  it("refuses a set fact whose set has no declared NamedSet", () => {
    const error = failureOf(ReadScopes.mapping({ collection: "posts", binding, attributes }));
    expect(error?.reason).toBe("UndeclaredSet");
    expect(error?.message).toContain("following");
  });

  it("ReadScopes.policy checks every collection's mapping when it is built", () => {
    const built = ReadScopes.policy({
      posts: { binding, attributes: { visibility: "visibility" }, compile },
    });
    expect(failureOf(built)?.reason).toBe("UnmappedAttribute");
  });
});

// ─── The translation ─────────────────────────────────────────────────────────

/** A filter scope over one predicate. */
const scopeOf = (predicate: AuthScope.Predicate): AuthScope.ReadScope => ({
  _tag: "Filter",
  predicate,
  sets: [],
});

/** The predicate of a translated filter scope. */
const predicateOf = (scope: Authorization.ReadScope): Predicate.Predicate =>
  P.isTagged(scope, "Filter") ? scope.predicate : assert.fail("expected a Filter");

/** The row fields the posts policies read. */
interface PostRow {
  readonly visibility: string;
  readonly ownerId: string;
}

describe("ReadScopes.translate", () => {
  const map = checked();

  it("maps AllowAll and Deny to legation's", () => {
    expect(ReadScopes.translate(AuthScope.allowAll, map)).toEqual(
      Result.succeed(Authorization.AllowAll)
    );
    expect(ReadScopes.translate(AuthScope.deny, map)).toEqual(Result.succeed(Authorization.Deny));
  });

  it("maps fields through the attributes map and guards every two-valued atom", () => {
    const translated = orFail(
      ReadScopes.translate(
        filterOf({
          _tag: "Filter",
          predicate: {
            _tag: "Or",
            predicates: [
              { _tag: "Eq", attribute: "owner", value: AuthScope.text("user-alice") },
              { _tag: "Not", predicate: { _tag: "IsNull", attribute: "score" } },
              { _tag: "InSet", attribute: "owner", set: "following" },
              { _tag: "Compare", op: "gte", attribute: "score", value: AuthScope.integer(3) },
            ],
          },
          sets: ["following"],
        }),
        map
      )
    );
    expect(translated).toEqual(
      Authorization.filter(
        Predicate.or(
          Predicate.and(Predicate.isNotNull("ownerId"), Predicate.eq("ownerId", "user-alice")),
          Predicate.not(Predicate.isNull("score")),
          Predicate.and(Predicate.isNotNull("ownerId"), Predicate.inSet("ownerId", "following")),
          Predicate.and(Predicate.isNotNull("score"), Predicate.gte("score", 3))
        ),
        { following }
      )
    );
  });

  it("is two-valued like effect-auth: Not(Eq) admits a row whose field is NULL", () => {
    const scope = orFail(
      ReadScopes.translate(
        filterOf({
          _tag: "Filter",
          predicate: {
            _tag: "Not",
            predicate: { _tag: "Eq", attribute: "visibility", value: AuthScope.text("private") },
          },
          sets: [],
        }),
        map
      )
    );
    const predicate = P.isTagged(scope, "Filter") ? scope.predicate : Predicate.always;
    expect(Predicate.test(predicate, { visibility: null })).toBe(true);
    expect(Predicate.test(predicate, {})).toBe(true);
    expect(Predicate.test(predicate, { visibility: "private" })).toBe(false);
  });

  describe("the anonymous principal is equal to no row's entity (#662)", () => {
    /** `owner == ""`, as effect-auth compiles an "own" policy for `User::""`. */
    const ownsEmpty: AuthScope.Predicate = {
      _tag: "Eq",
      attribute: "owner",
      value: AuthScope.text(""),
    };
    const never = Predicate.not(Predicate.always);
    const guarded = Predicate.and(Predicate.isNotNull("ownerId"), Predicate.eq("ownerId", ""));

    it("a positive entity Eq against the empty id is false for the anonymous principal", () => {
      const scope = scopeOf({
        _tag: "Or",
        predicates: [
          { _tag: "Eq", attribute: "visibility", value: AuthScope.text("public") },
          ownsEmpty,
        ],
      });
      const translated = predicateOf(
        orFail(ReadScopes.translate(scope, map, { principal: Principal.anonymous }))
      );
      expect(translated).toEqual(
        Predicate.or(
          Predicate.and(Predicate.isNotNull("visibility"), Predicate.eq("visibility", "public")),
          never
        )
      );
      expect(Predicate.test(translated, { visibility: "private", ownerId: "" })).toBe(false);
      expect(Predicate.test(translated, { visibility: "public", ownerId: "" })).toBe(true);
      // effect-auth's own answer admits the empty owner: the narrowing is legation-auth's.
      expect(AuthScope.matches(scope, { visibility: "private", owner: "" })).toBe(true);
    });

    it("is kept under a Not (false there would widen), and a double Not narrows", () => {
      const negated = predicateOf(
        orFail(
          ReadScopes.translate(scopeOf({ _tag: "Not", predicate: ownsEmpty }), map, {
            principal: Principal.anonymous,
          })
        )
      );
      expect(negated).toEqual(Predicate.not(guarded));
      expect(Predicate.test(negated, { ownerId: "" })).toBe(false);
      expect(Predicate.test(negated, { ownerId: "user-alice" })).toBe(true);
      const doubled = predicateOf(
        orFail(
          ReadScopes.translate(
            scopeOf({ _tag: "Not", predicate: { _tag: "Not", predicate: ownsEmpty } }),
            map,
            { principal: Principal.anonymous }
          )
        )
      );
      expect(doubled).toEqual(Predicate.not(Predicate.not(never)));
    });

    it("leaves a text attribute, a non-empty id, and every other principal alone", () => {
      const scope = scopeOf({
        _tag: "Or",
        predicates: [
          { _tag: "Eq", attribute: "visibility", value: AuthScope.text("") },
          { _tag: "Eq", attribute: "owner", value: AuthScope.text("user-alice") },
          ownsEmpty,
        ],
      });
      const exact = Predicate.or(
        Predicate.and(Predicate.isNotNull("visibility"), Predicate.eq("visibility", "")),
        Predicate.and(Predicate.isNotNull("ownerId"), Predicate.eq("ownerId", "user-alice")),
        guarded
      );
      expect(predicateOf(orFail(ReadScopes.translate(scope, map)))).toEqual(exact);
      expect(
        predicateOf(
          orFail(ReadScopes.translate(scope, map, { principal: principalOf("user-alice") }))
        )
      ).toEqual(exact);
      expect(
        predicateOf(orFail(ReadScopes.translate(scope, map, { principal: Principal.anonymous })))
      ).toEqual(
        Predicate.or(
          Predicate.and(Predicate.isNotNull("visibility"), Predicate.eq("visibility", "")),
          Predicate.and(Predicate.isNotNull("ownerId"), Predicate.eq("ownerId", "user-alice")),
          never
        )
      );
    });

    it("still reports a translation failure before narrowing", () => {
      const unmapped = orFail(
        ReadScopes.mapping({
          collection: "posts",
          binding: { resourceType: "Post", attributes: { owner: { entity: "User" } } },
          attributes: { owner: "ownerId" },
        })
      );
      const kind = ReadScopes.translate(
        scopeOf({ _tag: "Eq", attribute: "owner", value: AuthScope.integer(0) }),
        unmapped,
        { principal: Principal.anonymous }
      );
      expect(failureOf(kind)?.reason).toBe("LiteralKind");
    });
  });
});

const ok = (scalar: AuthScope.Scalar) => orFail(ReadScopes.literal("posts", "a", scalar));
const reason = (scalar: AuthScope.Scalar) =>
  failureOf(ReadScopes.literal("posts", "a", scalar))?.reason;

describe("ReadScopes.literal: literal reconciliation", () => {
  it("maps Text, Integer, Double and Boolean to their JS values", () => {
    expect(ok(AuthScope.text("héllo 🌍"))).toBe("héllo 🌍");
    expect(ok(AuthScope.integer(-42))).toBe(-42);
    expect(ok(AuthScope.integer(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(ok(AuthScope.double(2.5))).toBe(2.5);
    expect(ok(AuthScope.boolean(false))).toBe(false);
  });

  it("formats an Instant exactly as Date#toISOString (ADR-0028 rule e)", () => {
    expect(ok(AuthScope.instant(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(ok(AuthScope.instant(1_700_000_000_123))).toBe("2023-11-14T22:13:20.123Z");
    expect(ok(AuthScope.instant(-1))).toBe("1969-12-31T23:59:59.999Z");
    expect(ok(AuthScope.instant(ReadScopes.minInstant))).toBe("0000-01-01T00:00:00.000Z");
    expect(ok(AuthScope.instant(ReadScopes.maxInstant))).toBe("9999-12-31T23:59:59.999Z");
    expect(ok(AuthScope.instant(1_762_905_600_007))).toBe("2025-11-12T00:00:00.007Z");
  });

  it("refuses literals outside their kind's domain, as typed failures", () => {
    expect(reason(AuthScope.integer(Number.MAX_SAFE_INTEGER + 1))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.integer(1.5))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.double(Number.NaN))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.double(Number.POSITIVE_INFINITY))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.instant(ReadScopes.maxInstant + 1))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.instant(ReadScopes.minInstant - 1))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.instant(1.5))).toBe("LiteralOutOfDomain");
    expect(reason(AuthScope.instant(Number.NaN))).toBe("LiteralOutOfDomain");
  });

  it("refuses a literal of another kind than the attribute's", () => {
    const error = failureOf(
      ReadScopes.translate(
        filterOf({
          _tag: "Filter",
          predicate: { _tag: "Eq", attribute: "score", value: AuthScope.text("3") },
          sets: [],
        }),
        checked()
      )
    );
    expect(error?.reason).toBe("LiteralKind");
  });
});

// ─── Every failure narrows ───────────────────────────────────────────────────

const authorizeWith = (
  filter: Authorization.AuthFilter,
  principal: Principal.Principal = principalOf("user-alice")
) =>
  Authorization.authorize(
    Authorization.policy({ posts: filter }),
    contextOf(principal),
    Subset.make({ collection: "posts" }),
    "server"
  );

/** Whether a subset's `where` admits no row: the `Deny` form `authorize` writes. */
const isDeny = (subset: Subset.Subset) => expect(subset.where).toEqual(Predicate.isIn("id", []));

const fixed =
  (compiled: AuthScope.Compiled): ReadScopes.Compile =>
  () =>
    Effect.succeed(compiled);

const failing: ReadScopes.Compile = () =>
  Effect.fail(new AuthorizationError({ message: "policy store down" }));
const dying: ReadScopes.Compile = () => Effect.die(new Crash({ message: "compiler crashed" }));

describe("ReadScopes.toAuthFilter: failures narrow to Deny, never widen", () => {
  it.effect("an Inexact compilation narrows", () =>
    Effect.gen(function* () {
      const inexact = AuthScope.compile(
        [
          Policy.permit({
            id: "tagged",
            when: Condition.contains(resource("visibility"), Condition.lit("x")),
          }),
        ],
        binding,
        requestOf(principalOf("user-alice"))
      );
      expect(inexact._tag).toBe("Inexact");
      isDeny(yield* authorizeWith(ReadScopes.toAuthFilter(fixed(inexact), checked())));
    })
  );

  it.effect("an un-mappable scope narrows (a Compare on text)", () =>
    Effect.gen(function* () {
      const scope = filterOf({
        _tag: "Filter",
        predicate: {
          _tag: "Or",
          predicates: [
            { _tag: "Eq", attribute: "visibility", value: AuthScope.text("public") },
            { _tag: "Compare", op: "lt", attribute: "visibility", value: AuthScope.text("m") },
          ],
        },
        sets: [],
      });
      expect(failureOf(ReadScopes.translate(scope, checked()))?.reason).toBe("UnmappableNode");
      const authorized = yield* authorizeWith(
        ReadScopes.toAuthFilter(fixed({ _tag: "Exact", scope }), checked())
      );
      // The whole scope narrows: the mappable disjunct is not kept on its own.
      isDeny(authorized);
    })
  );

  it.effect("an out-of-domain literal narrows", () =>
    Effect.gen(function* () {
      const scope = filterOf({
        _tag: "Filter",
        predicate: {
          _tag: "Compare",
          op: "gt",
          attribute: "publishedAt",
          value: AuthScope.instant(1e300),
        },
        sets: [],
      });
      isDeny(
        yield* authorizeWith(ReadScopes.toAuthFilter(fixed({ _tag: "Exact", scope }), checked()))
      );
    })
  );

  it.effect("a failing or dying compile narrows, and the filter never fails", () =>
    Effect.gen(function* () {
      isDeny(yield* authorizeWith(ReadScopes.toAuthFilter(failing, checked())));
      isDeny(yield* authorizeWith(ReadScopes.toAuthFilter(dying, checked())));
    })
  );

  it.effect("an unresolvable named set narrows its branch; the others still apply", () =>
    Effect.gen(function* () {
      const broken: Authorization.NamedSet = {
        source: "follows",
        maxAge: "1 hour",
        resolve: () => Effect.fail(new AuthorizationError({ message: "cannot resolve" })),
      };
      const authorized = yield* authorizeWith(
        ReadScopes.toAuthFilter(compile, checked({ following: broken }))
      );
      const admits = (row: Readonly<Record<string, string>>) =>
        Predicate.test(authorized.where, row);
      expect(admits({ id: "p1", ownerId: "user-bob", visibility: "followers" })).toBe(false);
      expect(admits({ id: "p2", ownerId: "user-bob", visibility: "public" })).toBe(true);
      expect(admits({ id: "p3", ownerId: "user-alice", visibility: "private" })).toBe(true);
      // With the set resolved, the followers branch admits bob's post.
      const resolved = yield* authorizeWith(ReadScopes.toAuthFilter(compile, checked()));
      expect(
        Predicate.test(resolved.where, { id: "p1", ownerId: "user-bob", visibility: "followers" })
      ).toBe(true);
    })
  );

  it.effect("a set the scope names but the mapping does not declare binds to nothing", () =>
    Effect.gen(function* () {
      const scope = filterOf({
        _tag: "Filter",
        predicate: { _tag: "InSet", attribute: "owner", set: "blocked" },
        sets: ["blocked"],
      });
      const authorized = yield* authorizeWith(
        ReadScopes.toAuthFilter(fixed({ _tag: "Exact", scope }), checked())
      );
      expect(Predicate.test(authorized.where, { id: "p", ownerId: "user-bob" })).toBe(false);
    })
  );
});

describe("ReadScopes: roles and undeclared collections", () => {
  it.effect("a privileged role short-circuits to AllowAll, without a disjunction", () =>
    Effect.gen(function* () {
      const filter = ReadScopes.toAuthFilter(compile, checked());
      expect(yield* filter(contextOf(principalOf("user-mod")))).toEqual(Authorization.AllowAll);
      const subset = Subset.make({
        collection: "posts",
        where: Predicate.eq("visibility", "public"),
      });
      const authorized = yield* Authorization.authorize(
        Authorization.policy({ posts: filter }),
        contextOf(principalOf("user-mod")),
        subset,
        "server"
      );
      // The subset is untouched: no `Or` over the policy's axes is AND-ed in.
      expect(authorized).toEqual(subset);
    })
  );

  it.effect("an undeclared collection is unreachable", () =>
    Effect.gen(function* () {
      const built = orFail(
        ReadScopes.policy(
          { posts: { binding, attributes, sets: { following }, compile } },
          { filters: { tags: Authorization.allowAll } }
        )
      );
      const context = contextOf(principalOf("user-mod"));
      const error = yield* Effect.flip(
        Authorization.authorize(built, context, Subset.make({ collection: "secrets" }))
      );
      expect(error.message).toContain('No auth filter declared for collection "secrets"');
      // The listed ones are reachable.
      yield* Authorization.authorize(built, context, Subset.make({ collection: "posts" }));
      yield* Authorization.authorize(built, context, Subset.make({ collection: "tags" }));
    })
  );

  it.effect("the anonymous principal compiles too: public posts only", () =>
    Effect.gen(function* () {
      const authorized = yield* authorizeWith(
        ReadScopes.toAuthFilter(compile, checked()),
        Principal.anonymous
      );
      expect(Predicate.test(authorized.where, { visibility: "public", ownerId: "x" })).toBe(true);
      expect(Predicate.test(authorized.where, { visibility: "private", ownerId: "x" })).toBe(false);
    })
  );

  it.effect('an anonymous viewer cannot read a row whose owner is "" (#662)', () =>
    Effect.gen(function* () {
      const anonymous = yield* authorizeWith(
        ReadScopes.toAuthFilter(compile, checked()),
        Principal.anonymous
      );
      const anonymousAdmits = (row: PostRow) => Predicate.test(anonymous.where, row);
      expect(anonymousAdmits({ visibility: "private", ownerId: "" })).toBe(false);
      expect(anonymousAdmits({ visibility: "followers", ownerId: "" })).toBe(false);
      expect(anonymousAdmits({ visibility: "public", ownerId: "" })).toBe(true);
      expect(anonymousAdmits({ visibility: "public", ownerId: "user-alice" })).toBe(true);
      // A signed-in owner still reads their own rows, and nobody else's.
      const alice = yield* authorizeWith(ReadScopes.toAuthFilter(compile, checked()));
      const aliceAdmits = (row: PostRow) => Predicate.test(alice.where, row);
      expect(aliceAdmits({ visibility: "private", ownerId: "user-alice" })).toBe(true);
      expect(aliceAdmits({ visibility: "private", ownerId: "" })).toBe(false);
      expect(aliceAdmits({ visibility: "public", ownerId: "" })).toBe(true);
    })
  );
});

// ─── Subscription identity across a set change, through the sync server ──────

const PutArgs = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  visibility: Schema.String,
});
const putPost = Mutator.make("post/put", PutArgs);

const putIds = (patch: ReadonlyArray<{ readonly _tag: string }>) =>
  patch.flatMap((op) => (P.isTagged(op, "Put") && P.hasProperty(op, "id") ? [op.id] : []));

describe("ReadScopes behind SyncServer", () => {
  it.effect("keeps the subscription's authored scope while a named set's members change", () =>
    Effect.gen(function* () {
      const members = yield* Ref.make<ReadonlyArray<string>>([]);
      const live: Authorization.NamedSet = {
        source: "follows",
        // Resolved afresh on every pull, so the members move between two pulls.
        maxAge: "0 millis",
        resolve: () => Ref.get(members),
      };
      const scopes = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const filter = ReadScopes.toAuthFilter(compile, checked({ following: live }));
      const recording: Authorization.AuthFilter = (context) =>
        filter(context).pipe(Effect.tap((scope) => Ref.update(scopes, (all) => [...all, scope])));
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(putPost, (args, writer) => writer.put("posts", args.id, args)),
        ])
      );
      const server = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, Authorization.policy({ posts: recording })),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(
          InvalidationBus.InvalidationBus,
          yield* InvalidationBus.makeInProcess
        ),
        Effect.provideService(Authorization.IdentityResolver, {
          resolve: () => Effect.succeed(principalOf("user-alice")),
        })
      );
      yield* server.handlePush({
        clientGroupId: "writer",
        mutations: [
          {
            clientId: "w",
            mutationId: 1,
            mutator: "post/put",
            args: { id: "bob-f", ownerId: "user-bob", visibility: "followers" },
            createdAt: 0,
          },
          {
            clientId: "w",
            mutationId: 2,
            mutator: "post/put",
            args: { id: "pub", ownerId: "user-carol", visibility: "public" },
            createdAt: 0,
          },
        ],
      });
      const subscription = Subset.make({ collection: "posts" });
      const first = yield* server.handlePull({
        clientGroupId: "group-alice",
        subscriptions: [subscription],
      });
      expect(putIds(first.patch)).toEqual(["pub"]);

      yield* Ref.set(members, ["user-bob"]);
      const second = yield* server.handlePull({
        clientGroupId: "group-alice",
        subscriptions: [subscription],
        cookie: first.cookie,
      });
      expect(putIds(second.patch)).toContain("bob-f");

      // The same subscription, and the same authored scope both times: the
      // predicate names the set, never its members.
      const [before, after] = yield* Ref.get(scopes);
      expect(before).toBeDefined();
      expect(after).toEqual(before);
      expect(mentions(after, "user-bob")).toBe(false);
      expect(Arr.length(yield* Ref.get(scopes))).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.scoped)
  );
});
