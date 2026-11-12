/**
 * The glue an app no longer writes (#646, #648): the effect-auth compile
 * request built from a `Principal` (`ReadScopes.principalRequest`), with the
 * anonymous principal's entity pinned down, and the effect-auth `Binding`
 * derived from the node's schema (`ReadScopes.bindingOf`), so a kind mismatch
 * is a `ScopeMappingError` when the policy is built, never a `Deny` per request.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  AuthError,
  Condition,
  Entity,
  memoryEntityResolver,
  Policy,
  Rbac,
  ReadScope as AuthScope,
  type EntityResolver,
} from "@thomasfosterau/effect-auth";
import { fixtureUser } from "@thomasfosterau/effect-auth/testing";
import { Authorization, Edge, Node, Predicate } from "@thomasfosterau/legation";
import { Subset } from "@thomasfosterau/legation/internal";
import { Principal, ReadScopes } from "@thomasfosterau/legation-auth";
import { failureOf, orFail } from "./support.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const Post = Node.make("posts", {
  attributes: {
    visibility: Schema.Literals(["public", "followers", "private"]),
    publishedAt: Schema.String,
    score: Schema.Int,
    rating: Schema.Finite,
    pinned: Schema.Boolean,
    editedAt: Schema.Date,
  },
  edges: { owner: Edge.one("users", { via: "ownerId" }) },
  filterable: { publishedAt: { operators: ["lt", "gt"], kind: "instant" } },
});

const sessionOf = (id: string, role?: string): Principal.Principal => {
  const user = fixtureUser(role === undefined ? { id } : { id, role });
  return {
    _tag: "Session",
    userId: user.id,
    user,
    sessionAttributes: {},
    expiresAt: user.updatedAt,
  };
};

const apiKeyOf = (userId: string): Principal.Principal => ({
  _tag: "ApiKey",
  userId,
  keyId: `key-${userId}`,
  permissions: Option.none(),
});

const contextOf = (principal: Principal.Principal) => ({ clientGroupId: "g", identity: principal });

const resource = (name: string) => Condition.attr("resource", name);

/** Public posts and one's own; moderators read all. */
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
  Policy.role("moderator", { id: "moderator" }),
];

const read = ReadScopes.principalRequest({ action: "read" });

const derived = () =>
  ReadScopes.bindingOf(Post, {
    resourceType: "Post",
    attributes: {
      owner: { field: "ownerId", entity: "User" },
      visibility: "visibility",
    },
  });

/** A resolver that records every batch of refs it is asked for. */
const recording = Effect.fn("recording")(function* (entities: ReadonlyArray<Entity.Entity>) {
  const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
  const inner = memoryEntityResolver(entities);
  const resolver: typeof EntityResolver.Service = {
    resolve: (refs) =>
      Ref.update(asked, (seen) => [...seen, refs.map(Entity.formatRef)]).pipe(
        Effect.andThen(inner.resolve(refs))
      ),
  };
  return { resolver, asked };
});

// ─── principalRequest (#646) ─────────────────────────────────────────────────

describe("ReadScopes.principalRequest: the compile request from a Principal", () => {
  it.effect('the anonymous principal is User::"" with an empty slice', () =>
    Effect.gen(function* () {
      const request = yield* read(Principal.anonymous, contextOf(Principal.anonymous));
      expect(request.principal).toEqual(Entity.ref("User", ""));
      expect(Entity.formatRef(request.principal)).toBe('User::""');
      expect(request.action).toEqual(Entity.ref("Action", "read"));
      expect(HashMap.size(request.slice?.entities ?? HashMap.empty())).toBe(0);
      expect(ReadScopes.principalRef(Principal.anonymous)).toEqual(Entity.ref("User", ""));
      // It compiles to the public posts and nothing a role grants.
      const compiled = AuthScope.compile(policies, orFail(derived()).binding, request);
      expect(compiled).toEqual({
        _tag: "Exact",
        scope: {
          _tag: "Filter",
          predicate: {
            _tag: "Or",
            predicates: [
              { _tag: "Eq", attribute: "visibility", value: AuthScope.text("public") },
              { _tag: "Eq", attribute: "owner", value: AuthScope.text("") },
            ],
          },
          sets: [],
        },
      });
    })
  );

  it.effect("a session's user sits under its role, with the role attribute", () =>
    Effect.gen(function* () {
      const moderator = sessionOf("user-mod", "moderator");
      const request = yield* read(moderator, contextOf(moderator));
      const user = Entity.ref("User", "user-mod");
      expect(request.principal).toEqual(user);
      const entity = Entity.getEntity(request.slice ?? Entity.emptySlice, user);
      expect(entity?.parents).toEqual([Rbac.roleRef("moderator")]);
      expect(entity?.attributes).toEqual({ role: "moderator" });
      expect(AuthScope.compile(policies, orFail(derived()).binding, request)).toEqual({
        _tag: "Exact",
        scope: AuthScope.allowAll,
      });
    })
  );

  it.effect("a session without a role, and an API key, get no role", () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [sessionOf("user-alice"), apiKeyOf("user-mod")],
        (principal) =>
          Effect.map(read(principal, contextOf(principal)), (request) => {
            expect(HashMap.size(request.slice?.entities ?? HashMap.empty())).toBe(0);
          }),
        { concurrency: 1 }
      );
      const key = apiKeyOf("user-mod");
      const compiled = AuthScope.compile(
        policies,
        orFail(derived()).binding,
        yield* read(key, contextOf(key))
      );
      expect(compiled).not.toEqual({ _tag: "Exact", scope: AuthScope.allowAll });
    })
  );

  it.effect("takes an action ref and another principal type", () =>
    Effect.gen(function* () {
      const request = yield* ReadScopes.principalRequest({
        action: Entity.ref("Action", "list"),
        principalType: "Member",
      })(apiKeyOf("m1"), contextOf(apiKeyOf("m1")));
      expect(request.principal).toEqual(Entity.ref("Member", "m1"));
      expect(request.action).toEqual(Entity.ref("Action", "list"));
    })
  );

  it.effect("an EntityResolver supplies the slice; the anonymous principal is never resolved", () =>
    Effect.gen(function* () {
      const { resolver, asked } = yield* recording([
        Entity.entity(Entity.ref("User", "user-alice"), { parents: [Rbac.roleRef("moderator")] }),
        Entity.entity(Entity.ref("User", ""), { parents: [Rbac.roleRef("moderator")] }),
      ]);
      const request = ReadScopes.principalRequest({ action: "read", entities: resolver });
      const alice = apiKeyOf("user-alice");
      const aliceRequest = yield* request(alice, contextOf(alice));
      expect(AuthScope.compile(policies, orFail(derived()).binding, aliceRequest)).toEqual({
        _tag: "Exact",
        scope: AuthScope.allowAll,
      });
      const anonymous = yield* request(Principal.anonymous, contextOf(Principal.anonymous));
      // A resolver that (wrongly) knows `User::""` grants the anonymous reader nothing.
      expect(
        Entity.getEntity(anonymous.slice ?? Entity.emptySlice, Entity.ref("User", ""))
      ).toBeNull();
      expect(yield* Ref.get(asked)).toEqual([
        ['User::"user-alice"', 'Action::"read"'],
        ['Action::"read"'],
      ]);
    })
  );

  it.effect("a failing resolver narrows the filter to Deny", () =>
    Effect.gen(function* () {
      const failing: typeof EntityResolver.Service = {
        resolve: () => Effect.fail(new AuthError({ message: "store down" })),
      };
      const compile = ReadScopes.compiler({
        policies: () => Effect.succeed(policies),
        request: ReadScopes.principalRequest({ action: "read", entities: failing }),
      });
      const map = orFail(ReadScopes.mapping({ collection: "posts", ...orFail(derived()) }));
      const filter = ReadScopes.toAuthFilter(compile, map);
      expect(yield* filter(contextOf(sessionOf("user-alice")))).toEqual(Authorization.Deny);
    })
  );
});

// ─── bindingOf (#648) ────────────────────────────────────────────────────────

describe("ReadScopes.bindingOf: the binding derived from the node", () => {
  it("derives every attribute's kind from the node's schema", () => {
    const built = orFail(
      ReadScopes.bindingOf(Post, {
        resourceType: "Post",
        attributes: {
          owner: { field: "ownerId", entity: "User" },
          visibility: "visibility",
          publishedAt: "publishedAt",
          score: "score",
          rating: "rating",
          pinned: "pinned",
          postId: "id",
        },
        setFacts: { followsOwner: { attribute: "owner", set: "following" } },
      })
    );
    expect(built.binding).toEqual({
      resourceType: "Post",
      attributes: {
        owner: { entity: "User" },
        visibility: "Text",
        // The node declares it an instant; a string alone would be Text.
        publishedAt: "Instant",
        score: "Integer",
        rating: "Double",
        pinned: "Boolean",
        postId: "Text",
      },
      setFacts: { followsOwner: { attribute: "owner", set: "following" } },
    });
    expect(built.attributes).toEqual({
      owner: "ownerId",
      visibility: "visibility",
      publishedAt: "publishedAt",
      score: "score",
      rating: "rating",
      pinned: "pinned",
      postId: "id",
    });
  });

  it("a kind mismatch is a ScopeMappingError when the policy is built", () => {
    const mismatched = ReadScopes.bindingOf(Post, {
      resourceType: "Post",
      attributes: { owner: { field: "score", entity: "User" } },
    });
    const error = failureOf(mismatched);
    expect(error?._tag).toBe("ScopeMappingError");
    expect(error?.reason).toBe("FieldKind");
    expect(error?.collection).toBe("posts");
    expect(error?.message).toContain("integer");
    // Through the policy builder: no AuthPolicy, so no request ever sees a Deny for it.
    const compile = ReadScopes.compiler({
      policies: () => Effect.succeed(policies),
      request: read,
    });
    const built = Result.gen(function* () {
      const posts = yield* mismatched;
      return yield* ReadScopes.policy({ posts: { ...posts, compile } });
    });
    expect(failureOf(built)?.reason).toBe("FieldKind");
  });

  it("refuses a field whose kind cannot be derived, and a field the node lacks", () => {
    const underivable = failureOf(
      ReadScopes.bindingOf(Post, { resourceType: "Post", attributes: { edited: "editedAt" } })
    );
    expect(underivable?.reason).toBe("FieldKind");
    const missing = failureOf(
      ReadScopes.bindingOf(Post, { resourceType: "Post", attributes: { body: "body" } })
    );
    expect(missing?.reason).toBe("UnmappedAttribute");
    expect(missing?.message).toContain("body");
  });

  it.effect("a derived binding scopes the collection end to end", () =>
    Effect.gen(function* () {
      const compile = ReadScopes.compiler({
        policies: () => Effect.succeed(policies),
        request: read,
      });
      const policy = orFail(
        Result.flatMap(derived(), (posts) => ReadScopes.policy({ posts: { ...posts, compile } }))
      );
      const alice = sessionOf("user-alice");
      const authorized = yield* Authorization.authorize(
        policy,
        contextOf(alice),
        Subset.make({ collection: "posts" }),
        "server"
      );
      const admits = (row: {
        readonly id: string;
        readonly ownerId: string;
        readonly visibility: string;
      }) => Predicate.test(authorized.where, row);
      expect(admits({ id: "p1", ownerId: "user-alice", visibility: "private" })).toBe(true);
      expect(admits({ id: "p2", ownerId: "user-bob", visibility: "public" })).toBe(true);
      expect(admits({ id: "p3", ownerId: "user-bob", visibility: "private" })).toBe(false);
    })
  );
});
