/**
 * Test 1 of #221 — one corpus, four viewers (and nobody): the owner, a
 * follower, a stranger and a moderator each subscribe to the same
 * collection on their own device, and each replica holds exactly the rows
 * the viewer's effect-auth policy admits. Asserted on what the durable
 * store holds, not only on what a query answers.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { feed } from "../src/domain.js";
import { makeDevice } from "../src/device.js";
import { alice, bob, carol, idsOf, makeSeededWorld, mona } from "./support/world.js";

describe("one corpus, one collection, a replica per viewer", () => {
  it.effect("each replica holds exactly the rows its viewer's policy admits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        const expected: ReadonlyArray<
          readonly [string, { readonly id: string } | undefined, ReadonlyArray<string>]
        > = [
          // Own posts of every visibility, and the public rest.
          ["owner", alice, ["a-followers", "a-private", "a-public", "b-public"]],
          // Alice's followers-only post through the `following` named set, and his own.
          ["follower", bob, ["a-followers", "a-public", "b-private", "b-public"]],
          // Public posts and her own; no follower relation reaches anything else.
          ["stranger", carol, ["a-public", "b-public", "c-followers"]],
          // The role short-circuit: `AllowAll`, every row.
          [
            "moderator",
            mona,
            ["a-followers", "a-private", "a-public", "b-private", "b-public", "c-followers"],
          ],
          // Signed out: `User::""`, which only the public rule admits.
          ["anonymous", undefined, ["a-public", "b-public"]],
        ];
        for (const [name, user, ids] of expected) {
          const device = yield* makeDevice(world.audience, name);
          if (user !== undefined) yield* device.signIn(world.session(user));
          yield* device.client.subscribe(feed);
          yield* device.engine.pull;
          expect(idsOf(yield* device.stored), name).toEqual(ids);
          expect(idsOf(yield* device.posts(feed)), name).toEqual(ids);
        }
      })
    )
  );
});
