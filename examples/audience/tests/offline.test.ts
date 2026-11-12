/**
 * Test 5 of #221 — offline is still bounded. The follower syncs, then the
 * network goes down. Offline, the replica answers what it answered online
 * and nothing more: no read the pin covers widens past the policy, a read
 * the replica does not cover is the façade's `503` (never a partial
 * document) and, through the Client, at most the admitted rows it holds,
 * and nothing written on the server meanwhile leaks in. Back online, one
 * pull brings the replica to exactly the current policy — including a post
 * its owner narrowed while the follower was away, which leaves.
 *
 * Signing out offline still clears the replica: the reset needs no network.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import { byOwner, byVisibility, feed, putPost } from "../src/domain.js";
import { makeDevice } from "../src/device.js";
import { alice, bob, carol, idsOf, makeSeededWorld } from "./support/world.js";

const followerView = ["a-followers", "a-public", "b-private", "b-public"];

const jsonApi = (path: string) =>
  new Request(`http://audience.test${path}`, { headers: { accept: "application/vnd.api+json" } });

describe("offline is still bounded", () => {
  it.effect("going offline never widens what the replica answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        const device = yield* makeDevice(world.audience, "commuter");
        yield* device.signIn(world.session(bob));
        // The whole feed, and a narrower pin a second read is judged against.
        yield* device.client.subscribe(feed);
        yield* device.engine.pull;
        expect(idsOf(yield* device.stored)).toEqual(followerView);
        const online = Option.getOrThrow(yield* device.facade.handle(jsonApi("/jsonapi/posts")));
        const onlineBody = yield* Effect.promise(() => online.text());

        yield* device.setOnline(false);

        // The same reads answer the same rows, and no more.
        expect(idsOf(yield* device.posts(feed))).toEqual(followerView);
        expect(idsOf(yield* device.posts(byOwner(alice.id)))).toEqual(["a-followers", "a-public"]);
        expect(idsOf(yield* device.posts(byVisibility("private")))).toEqual(["b-private"]);
        expect(yield* device.posts(byOwner(carol.id))).toEqual([]);
        // The façade serves the covered listing from the replica, unchanged.
        const offline = Option.getOrThrow(yield* device.facade.handle(jsonApi("/jsonapi/posts")));
        expect(offline.status).toBe(200);
        expect(yield* Effect.promise(() => offline.text())).toBe(onlineBody);
        // A row the replica does not hold is the server's to answer (only it can
        // write the 404): the façade forwards it, the forward fails at the
        // network, and the worker answers with the façade's `offline` document.
        const missing = jsonApi("/jsonapi/posts/a-private");
        expect(yield* device.facade.handle(missing)).toEqual(Option.none());
        const answered = yield* device.facade.offline(missing);
        expect(answered.status).toBe(503);
        expect(yield* Effect.promise(() => answered.text())).not.toContain("a note to self");
        // A pull cannot widen anything: it fails.
        expect(Exit.isFailure(yield* Effect.exit(device.engine.pull))).toBe(true);

        // Meanwhile, on the server: Alice publishes to her followers and to herself,
        // and narrows her followers-only post to private.
        yield* world.audience.mutateAs(world.session(alice), putPost, {
          id: "a-new-followers",
          ownerId: alice.id,
          visibility: "followers",
          body: "while you were away",
        });
        yield* world.audience.mutateAs(world.session(alice), putPost, {
          id: "a-new-private",
          ownerId: alice.id,
          visibility: "private",
          body: "never for bob",
        });
        yield* world.audience.mutateAs(world.session(alice), putPost, {
          id: "a-followers",
          ownerId: alice.id,
          visibility: "private",
          body: "for my followers",
        });
        // Offline, none of it reaches the replica.
        expect(idsOf(yield* device.stored)).toEqual(followerView);

        // Back online: exactly the current policy, the narrowed post gone.
        yield* device.setOnline(true);
        yield* device.engine.pull;
        expect(idsOf(yield* device.stored)).toEqual([
          "a-new-followers",
          "a-public",
          "b-private",
          "b-public",
        ]);
      })
    )
  );

  it.effect("an uncovered read offline is the 503, never a partial replica", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        const device = yield* makeDevice(world.audience, "narrow");
        yield* device.signIn(world.session(bob));
        // Only the public posts are pinned.
        yield* device.client.subscribe(byVisibility("public"));
        yield* device.engine.pull;
        expect(idsOf(yield* device.stored)).toEqual(["a-public", "b-public"]);
        yield* device.setOnline(false);
        // The whole listing is not covered by the narrower pin: offline it is the
        // `offline` error document, not the public rows passed off as the feed.
        const listing = Option.getOrThrow(yield* device.facade.handle(jsonApi("/jsonapi/posts")));
        expect(listing.status).toBe(503);
        // Through the Client, the uncovered read falls through to the server,
        // which is unreachable, so it answers locally (ADR-0025: local is always
        // an answer): the rows the replica holds, which the policy admitted —
        // narrower than the feed, never wider.
        expect(idsOf(yield* device.posts(feed))).toEqual(["a-public", "b-public"]);
        // The covered read still answers.
        expect(idsOf(yield* device.posts(byVisibility("public")))).toEqual([
          "a-public",
          "b-public",
        ]);
      })
    )
  );

  it.effect("signing out offline still clears the replica", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        const device = yield* makeDevice(world.audience, "offline-sign-out");
        yield* device.signIn(world.session(bob));
        yield* device.client.subscribe(feed);
        yield* device.engine.pull;
        yield* device.setOnline(false);
        expect((yield* device.signOut).transition).toBe("Reset");
        expect(yield* device.stored).toEqual([]);
        // And the façade has nothing of Bob's left to serve: offline, his own row is the 503.
        expect(
          Option.map(yield* device.facade.handle(jsonApi("/jsonapi/posts/b-private")), (r) => r.status)
        ).toEqual(Option.some(503));
      })
    )
  );
});
