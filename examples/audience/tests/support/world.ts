/**
 * The world the tests stand up: the audience server over fresh state, four
 * effect-auth fixture users signed in, and the fixture corpus written through
 * the sync server as each post's owner.
 */
import * as Effect from "effect/Effect";
import { fixtureUser } from "@thomasfosterau/effect-auth/testing";
import { follow, type Follow, type Post, putPost } from "../../src/domain.js";
import { MODERATOR } from "../../src/policy.js";
import { type AudienceServer, makeServer, type Session } from "../../src/server.js";

/** The owner of the corpus's first posts. */
export const alice = fixtureUser({ id: "user-alice", name: "Alice" });
/** Follows Alice. */
export const bob = fixtureUser({ id: "user-bob", name: "Bob" });
/** Follows nobody, followed by nobody. */
export const carol = fixtureUser({ id: "user-carol", name: "Carol" });
/** The privileged role. */
export const mona = fixtureUser({ id: "user-mona", name: "Mona", role: MODERATOR });

export const users = [alice, bob, carol, mona] as const;

/** The fixture corpus: every visibility, three owners. */
export const corpus: ReadonlyArray<Post> = [
  { id: "a-public", ownerId: alice.id, visibility: "public", body: "hello, world" },
  { id: "a-followers", ownerId: alice.id, visibility: "followers", body: "for my followers" },
  { id: "a-private", ownerId: alice.id, visibility: "private", body: "a note to self" },
  { id: "b-public", ownerId: bob.id, visibility: "public", body: "bob says hi" },
  { id: "b-private", ownerId: bob.id, visibility: "private", body: "bob's diary" },
  { id: "c-followers", ownerId: carol.id, visibility: "followers", body: "nobody follows carol" },
];

/** The fixture follow graph. */
export const follows: ReadonlyArray<Follow> = [{ followerId: bob.id, followeeId: alice.id }];

export interface World {
  readonly audience: AudienceServer;
  /** Each fixture user's session, by user id. */
  readonly sessions: ReadonlyMap<string, Session>;
  readonly session: (user: { readonly id: string }) => Session;
}

/** Write posts and follows through the sync server, each as its author. */
export const seed = (
  world: World,
  posts: ReadonlyArray<Post>,
  edges: ReadonlyArray<Follow>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const post of posts) {
      const receipt = yield* world.audience.mutateAs(
        world.session({ id: post.ownerId }),
        putPost,
        post
      );
      if (receipt.phase !== "acknowledged") yield* Effect.die(`seed rejected: ${post.id}`);
    }
    for (const edge of edges) {
      const receipt = yield* world.audience.mutateAs(
        world.session({ id: edge.followerId }),
        follow,
        edge
      );
      if (receipt.phase !== "acknowledged") yield* Effect.die(`seed rejected: ${edge.followerId}`);
    }
  });

/** The server with every fixture user signed in, and nothing written yet; scoped. */
export const makeWorld = (people: ReadonlyArray<typeof alice> = users) =>
  Effect.gen(function* () {
    const audience = yield* makeServer(people);
    const sessions = new Map<string, Session>();
    for (const user of people) sessions.set(user.id, yield* audience.signIn(user));
    const world: World = {
      audience,
      sessions,
      session: (user) => {
        const found = sessions.get(user.id);
        if (found === undefined) throw new Error(`no session for ${user.id}`);
        return found;
      },
    };
    return world;
  });

/** The world with the fixture corpus written; scoped. */
export const makeSeededWorld = Effect.gen(function* () {
  const world = yield* makeWorld();
  yield* seed(world, corpus, follows);
  return world;
});

/** Sorted ids, for comparing replicas. */
export const idsOf = (rows: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  rows.map((row) => row.id).toSorted();
