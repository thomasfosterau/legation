/**
 * Test 2 of #221 — the filter is the policy. A property test over generated
 * corpora: for every viewer, the rows a subscription to `posts` yields —
 * across the boundary, through the real sync server (identity resolved from
 * the session cookie, the scope compiled and translated, the auth filter
 * AND-ed in, the CVR diff, the patch) into the client's durable replica —
 * equal the rows effect-auth admits row by row, by two oracles:
 *
 * - `ReadScope.matches`: the viewer's compiled scope tested against each row,
 *   with the `following` set answered from the corpus's follow graph;
 * - `Policy.decidePure`: effect-auth's own decision procedure, asked of each
 *   row as a `Post` resource with the set fact in its context.
 *
 * Each corpus then moves its follow graph (follows and unfollows written by
 * the followers themselves) and the replicas pull again: the named set's
 * members move, and the replicas follow them exactly.
 *
 * Generated as the repository's other corpus tests are: Effect's `Random`
 * under `Random.withSeed`, so a seed reproduces a corpus and a failure names it.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import { Entity, Policy, ReadScope as AuthScope } from "@thomasfosterau/effect-auth";
import { fixtureUser } from "@thomasfosterau/effect-auth/testing";
import { Authorization, type Backend } from "@thomasfosterau/legation";
import { Principal } from "@thomasfosterau/legation-auth";
import {
  feed,
  type Follow,
  followId,
  type Post,
  unfollow,
  follow,
  type Visibility,
} from "../src/domain.js";
import { binding, MODERATOR, policies, readAction, readRequest } from "../src/policy.js";
import { cookieHeader, type Session } from "../src/server.js";
import { type Device, makeDevice } from "../src/device.js";
import { idsOf, makeWorld, seed, type World } from "./support/world.js";

const SEED = 20261112;
const CORPORA = 6;
const USERS = 6;
const POSTS = 40;
const FOLLOW_ODDS = 0.35;
const MOVES = 8;
/** Scheduler turns given to the server's hint fan-out after the follow graph moves. */
const FANOUT_TURNS = 100;

const visibilities: Arr.NonEmptyReadonlyArray<Visibility> = ["public", "followers", "private"];

/** The corpus's users: `u0` is a moderator, the rest plain members. */
const people = Arr.makeBy(USERS, (index) =>
  fixtureUser({
    id: `user-${index}`,
    name: `User ${index}`,
    ...(index === 0 ? { role: MODERATOR } : {}),
  })
);

const pick = <A>(xs: Arr.NonEmptyReadonlyArray<A>): Effect.Effect<A> =>
  Effect.map(Random.nextIntBetween(0, xs.length, { halfOpen: true }), (index) =>
    Option.getOrElse(Arr.get(xs, index), () => xs[0])
  );

const userIds = Arr.map(people, (user) => user.id) as unknown as Arr.NonEmptyReadonlyArray<string>;

/** One corpus: posts of every visibility by random owners, and a random follow graph. */
const generate = (corpus: number) =>
  Effect.gen(function* () {
    const posts = yield* Effect.forEach(
      Arr.range(0, POSTS - 1),
      (index) =>
        Effect.all({ ownerId: pick(userIds), visibility: pick(visibilities) }).pipe(
          Effect.map(({ ownerId, visibility }): Post => ({
            id: `c${corpus}-p${index}`,
            ownerId,
            visibility,
            body: `post ${index} of corpus ${corpus}`,
          }))
        ),
      { concurrency: 1 }
    );
    const pairs = Arr.flatMap(userIds, (followerId) =>
      Arr.flatMap(userIds, (followeeId): ReadonlyArray<Follow> =>
        followerId === followeeId ? [] : [{ followerId, followeeId }]
      )
    );
    const edges = yield* Effect.filter(pairs, () =>
      Effect.map(Random.next, (draw) => draw < FOLLOW_ODDS)
    );
    // The follow-graph moves applied after the first comparison: a toggle of a random pair each.
    if (!Arr.isReadonlyArrayNonEmpty(pairs)) return yield* Effect.die("a corpus needs two users");
    const moves = yield* Effect.forEach(Arr.range(1, MOVES), () => pick(pairs), { concurrency: 1 });
    return { posts, edges, moves };
  });

/** What effect-auth admits of `posts` for `principal`, by both oracles. */
const oracles = (
  principal: Principal.Principal,
  posts: ReadonlyArray<Post>,
  edges: ReadonlyArray<Follow>
) =>
  Effect.gen(function* () {
    const request = yield* readRequest(principal, {
      clientGroupId: "corpus",
      identity: principal,
    }).pipe(Effect.orDie);
    const viewer = request.principal.id;
    const followees = new Set(
      edges.filter((edge) => edge.followerId === viewer).map((edge) => edge.followeeId)
    );
    const compiled = AuthScope.compile(policies, binding, request);
    if (compiled._tag !== "Exact") throw new Error(`inexact: ${compiled.reasons.join("; ")}`);
    const matches = posts
      .filter((post) =>
        AuthScope.matches(
          compiled.scope,
          { owner: post.ownerId, visibility: post.visibility },
          (set, value) => set === "following" && typeof value === "string" && followees.has(value)
        )
      )
      .map((post) => post.id);
    const decided = posts
      .filter((post) => {
        const resource = Entity.ref("Post", post.id);
        const slice = Entity.slice([
          ...(request.slice === undefined
            ? []
            : [...request.slice.entities].map(([, entity]) => entity)),
          Entity.entity(resource, {
            attributes: {
              owner: Entity.entityValue(Entity.ref("User", post.ownerId)),
              visibility: post.visibility,
            },
          }),
        ]);
        return Policy.decidePure(
          policies,
          Policy.request({
            principal: request.principal,
            action: readAction,
            resource,
            context: { followsOwner: followees.has(post.ownerId) },
          }),
          slice
        ).allowed;
      })
      .map((post) => post.id);
    return { scope: compiled.scope._tag, matches: matches.toSorted(), decided: decided.toSorted() };
  });

/** The principal the server resolves a session's cookie to (anonymous for none). */
const principalOf = (world: World, session: Session | undefined) =>
  world.audience.identity
    .resolve({
      clientGroupId: "oracle",
      credentials:
        session === undefined
          ? Authorization.noCredentials
          : Authorization.credentialsFromHeaders({ cookie: cookieHeader(session.token) }),
    })
    .pipe(
      Effect.map((identity) =>
        Principal.fromContext({ clientGroupId: "oracle", identity } satisfies Backend.SyncContext)
      ),
      Effect.orDie
    );

/** One viewer's replica beside what each oracle admits, as sorted ids. */
interface Comparison {
  readonly viewer: string;
  readonly scope: string;
  readonly replica: ReadonlyArray<string>;
  readonly matches: ReadonlyArray<string>;
  readonly decided: ReadonlyArray<string>;
}

interface Viewer {
  readonly name: string;
  readonly session: Session | undefined;
  readonly device: Device;
}

/** Compare every viewer's replica with both oracles; the per-viewer results. */
const compare = (
  world: World,
  viewers: ReadonlyArray<Viewer>,
  posts: ReadonlyArray<Post>,
  edges: ReadonlyArray<Follow>
): Effect.Effect<ReadonlyArray<Comparison>> =>
  Effect.forEach(
    viewers,
    (viewer) =>
      Effect.gen(function* () {
        yield* viewer.device.engine.pull.pipe(Effect.orDie);
        const replica = idsOf(yield* viewer.device.stored);
        const { scope, matches, decided } = yield* oracles(
          yield* principalOf(world, viewer.session),
          posts,
          edges
        );
        return { viewer: viewer.name, scope, replica, matches, decided };
      }),
    { concurrency: 1 }
  );

describe("the filter is the policy: replicas against effect-auth, over generated corpora", () => {
  it.effect(
    `agrees row by row for every viewer over ${CORPORA} corpora of ${POSTS} posts (seed ${SEED})`,
    () =>
      Effect.gen(function* () {
        const followersReached = new Set<string>();
        const results: Array<Comparison & { readonly corpus: number; readonly phase: string }> = [];
        for (const corpus of Arr.range(0, CORPORA - 1)) {
          const { posts, edges, moves } = yield* generate(corpus).pipe(
            Random.withSeed(SEED + corpus)
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const world = yield* makeWorld(people);
              yield* seed(world, posts, edges);
              const viewers: Array<Viewer> = [];
              for (const user of [...people, undefined]) {
                const name = user?.id ?? "anonymous";
                const device = yield* makeDevice(world.audience, `${corpus}-${name}`);
                const session = user === undefined ? undefined : world.session(user);
                if (session !== undefined) yield* device.signIn(session);
                yield* device.client.subscribe(feed);
                viewers.push({ name, session, device });
              }
              const byId = new Map(posts.map((post) => [post.id, post]));
              const record = (phase: string, result: Comparison) => {
                results.push({ corpus, phase, ...result });
                const reached = result.replica.some((id) => {
                  const post = byId.get(id);
                  return post?.visibility === "followers" && post.ownerId !== result.viewer;
                });
                if (reached && result.scope === "Filter") followersReached.add(phase);
              };
              for (const result of yield* compare(world, viewers, posts, edges))
                record("seeded", result);
              // Move the follow graph, each change written by its follower.
              const graph = new Map(edges.map((edge) => [followId(edge), edge]));
              for (const move of moves) {
                const following = graph.has(followId(move));
                const receipt = yield* world.audience.mutateAs(
                  world.session({ id: move.followerId }),
                  following ? unfollow : follow,
                  move
                );
                expect(receipt.phase).toBe("acknowledged");
                if (following) graph.delete(followId(move));
                else graph.set(followId(move), move);
              }
              // The server's fan-out marks every session's cached `following` set
              // stale off the writes' hints, on its own fiber (#205): let it run
              // before the next pull, as the poke it sends would.
              yield* Effect.forEach(Arr.range(1, FANOUT_TURNS), () => Effect.yieldNow, {
                discard: true,
              });
              for (const result of yield* compare(world, viewers, posts, [...graph.values()])) {
                record("moved", result);
              }
            })
          );
        }
        const disagreements = results.filter(
          ({ replica, matches, decided }) =>
            replica.join(",") !== matches.join(",") || matches.join(",") !== decided.join(",")
        );
        // Reported with the seed, so a failure reproduces.
        expect(disagreements.slice(0, 3).map((d) => ({ seed: SEED + d.corpus, ...d }))).toEqual([]);
        expect(results).toHaveLength(CORPORA * 2 * (USERS + 1));
        // Every scope shape is exercised: the moderator's AllowAll, and real filters.
        expect(new Set(results.map(({ scope }) => scope))).toEqual(new Set(["AllowAll", "Filter"]));
        // The corpora discriminate: most viewers see some rows and not all.
        const partial = results.filter(
          ({ replica }) => replica.length > 0 && replica.length < POSTS
        );
        expect(partial.length).toBeGreaterThan(results.length / 2);
        // The followers rule matters: a member's replica holds another owner's
        // followers-only posts through the named set, in both phases.
        expect(followersReached.size).toBe(2);
      }),
    60_000
  );
});
