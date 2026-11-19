/**
 * `Authorization.namedSet` (#647): a named set whose members are read off a
 * backend collection. Its members are the distinct member values of the rows
 * `where` selects; `where` returning `None` (an anonymous viewer) is the empty
 * set without a read; a `BackendError` is an `AuthorizationError` naming the
 * source, which binds the set to nothing.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Authorization from "../Authorization.js";
import type { Backend, SyncContext } from "../Backend.js";
import { AuthorizationError, BackendError } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";

interface Seed {
  readonly id: string;
  readonly value: unknown;
}

const follows: ReadonlyArray<Seed> = [
  { id: "f-1", value: { follower: "alice", followee: "bob" } },
  { id: "f-2", value: { follower: "alice", followee: "carol" } },
  // A second edge to bob: one member, not two.
  { id: "f-3", value: { follower: "alice", followee: "bob" } },
  // No member value, or one that is not a scalar: no member.
  { id: "f-4", value: { follower: "alice", followee: null } },
  { id: "f-5", value: { follower: "alice", followee: { id: "dave" } } },
  { id: "f-6", value: { follower: "alice" } },
  { id: "f-7", value: { follower: "bob", followee: "alice" } },
];

const putFollow = Mutator.make(
  "follow/put",
  Schema.Struct({ id: Schema.String, value: Schema.Unknown })
);

/** A memory backend holding `follows`, counting the reads made through it. */
const makeBackend = Effect.fn("makeBackend")(function* () {
  const memory = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(putFollow, (seed, writer) =>
        writer.put("follows", seed.id, seed.value)
      ),
    ])
  );
  yield* memory.applyMutations(
    { clientGroupId: "seed" },
    follows.map((seed, index) => ({
      clientId: "seed",
      mutationId: index + 1,
      mutator: "follow/put",
      args: seed,
      createdAt: 0,
    }))
  );
  let reads = 0;
  const backend: Backend = {
    ...memory,
    evaluate: (context, subset) => {
      reads++;
      return memory.evaluate(context, subset);
    },
  };
  return { backend, reads: () => reads };
});

/** The users the viewer (`identity`, a user id) follows; none for an anonymous viewer. */
const followingOver = (backend: Backend): Authorization.NamedSet =>
  Authorization.namedSet(backend, {
    source: "follows",
    where: (context) =>
      Option.map(Option.liftPredicate(context.identity, P.isString), (user) =>
        Predicate.eq("follower", user)
      ),
    member: "followee",
    maxAge: "1 hour",
  });

const viewer = (identity?: string): SyncContext =>
  identity === undefined ? { clientGroupId: "g" } : { clientGroupId: "g", identity };

describe("Authorization.namedSet (#647)", () => {
  it.effect("declares its source and maxAge, and reads the distinct scalar members", () =>
    Effect.gen(function* () {
      const { backend } = yield* makeBackend();
      const following = followingOver(backend);
      expect(following.source).toBe("follows");
      expect(following.maxAge).toBe("1 hour");
      const members = yield* following.resolve(viewer("alice"));
      expect(members).toEqual(["bob", "carol"]);
      expect(yield* following.resolve(viewer("bob"))).toEqual(["alice"]);
      expect(yield* following.resolve(viewer("erin"))).toEqual([]);
    })
  );

  it.effect("binds the empty set for an anonymous viewer without reading the backend", () =>
    Effect.gen(function* () {
      const { backend, reads } = yield* makeBackend();
      expect(yield* followingOver(backend).resolve(viewer())).toEqual([]);
      expect(reads()).toBe(0);
    })
  );

  it.effect("fails a backend failure as an AuthorizationError naming the source", () =>
    Effect.gen(function* () {
      const { backend } = yield* makeBackend();
      const failing: Backend = {
        ...backend,
        getRows: () => Effect.fail(new BackendError({ message: "connection reset" })),
      };
      const error = yield* Effect.flip(followingOver(failing).resolve(viewer("alice")));
      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error.collection).toBe("follows");
      expect(error.message).toContain("connection reset");
      // Bound for a request, a failed resolution narrows: it binds nothing.
      const bound = yield* Authorization.resolveSet(
        viewer("alice"),
        "posts",
        "following",
        followingOver(failing)
      );
      expect(bound).toEqual(Option.none());
    })
  );
});
