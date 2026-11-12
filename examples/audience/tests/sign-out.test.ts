/**
 * Test 4 of #221 — sign-out clears the replica. Viewer A signs in on a
 * device and syncs; A signs out; viewer B signs in on the same device (the
 * same profile, the same durable store, the same client group) and cannot
 * read a single row only A was admitted to — not before B's first pull, not
 * after it, not through the façade.
 *
 * The listener is legation-auth's `SignOut.onSessionChange` over the Client
 * (#212): the sign-out is a `Reset` (confirmed rows, cookie and pins
 * dropped), and A's unpushed draft is quarantined under A's fingerprint —
 * never pushed under B's session, never discarded.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Identity } from "@thomasfosterau/legation";
import { SignOut } from "@thomasfosterau/legation-auth/client";
import * as Digest from "effect/crypto/Digest";
import { feed } from "../src/domain.js";
import { makeDevice } from "../src/device.js";
import { alice, carol, idsOf, makeSeededWorld, mona } from "./support/world.js";

/** What Alice may read and Carol may not. */
const alicesOnly = ["a-followers", "a-private"];

describe("sign-out clears the replica before the next viewer reads", () => {
  it.effect("viewer B, on viewer A's device, cannot read A's rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        const device = yield* makeDevice(world.audience, "shared-laptop");

        // A signs in: signed out → signed in is an upgrade, nothing to drop.
        expect((yield* device.signIn(world.session(alice))).transition).toBe("Upgrade");
        yield* device.client.subscribe(feed);
        yield* device.engine.pull;
        expect(idsOf(yield* device.stored)).toEqual([
          "a-followers",
          "a-private",
          "a-public",
          "b-public",
        ]);
        // An unpushed draft: A's pending journal at sign-out.
        const draft = {
          id: "a-draft",
          ownerId: alice.id,
          visibility: "private",
          body: "unsent",
        } as const;
        yield* device.client.mutate("post/put", draft);
        expect(idsOf(yield* device.posts(feed))).toContain("a-draft");

        // A signs out: effect-auth invalidates the session, the jar empties, the replica resets.
        const signedOut = yield* device.signOut;
        expect(signedOut.transition).toBe("Reset");
        expect(signedOut.quarantined).toBe(1);
        const aliceFingerprint = yield* SignOut.fingerprintOf(alice.id).pipe(
          Effect.provide(Digest.layerWebCrypto)
        );
        expect(signedOut.quarantinedUnder).toBe(aliceFingerprint);
        expect(yield* device.client.identity).toBe(Identity.anonymous);
        // Nothing of A's is left to read: not stored, no cookie, no pin. A read
        // the replica no longer covers falls through to the server (ADR-0025),
        // which answers it as the anonymous viewer the jar now makes this device.
        expect(yield* device.stored).toEqual([]);
        expect(idsOf(yield* device.posts(feed))).toEqual(["a-public", "b-public"]);
        expect(yield* device.store.getCookie).toBeUndefined();
        expect(yield* device.store.pendingMutations).toEqual([]);

        // B signs in on the same device.
        expect((yield* device.signIn(world.session(carol))).transition).toBe("Upgrade");
        // Before B's first pull, nothing of A's: the replica is empty, and the
        // read falls through to the server under B's session.
        expect(yield* device.stored).toEqual([]);
        expect(idsOf(yield* device.posts(feed))).toEqual(["a-public", "b-public", "c-followers"]);
        const aPrivate = new Request("http://audience.test/jsonapi/posts/a-private", {
          headers: { accept: "application/vnd.api+json" },
        });
        expect(yield* device.facade.handle(aPrivate)).toBeUndefined();
        yield* device.client.subscribe(feed);
        yield* device.engine.pull;
        // After it, exactly B's rows: A's private and followers-only posts are not among them.
        expect(idsOf(yield* device.stored)).toEqual(["a-public", "b-public", "c-followers"]);
        for (const id of [...alicesOnly, "a-draft"]) {
          expect(idsOf(yield* device.stored), id).not.toContain(id);
        }
        // B's push carries nothing of A's: the draft stays quarantined under A.
        yield* device.engine.push;
        expect(yield* device.client.quarantines).toEqual([aliceFingerprint]);
        expect(
          (yield* device.client.quarantinedMutations(aliceFingerprint)).map((m) => m.args)
        ).toEqual([draft]);
        // Nothing of A's draft reached the server: the moderator, who reads everything, has no such row.
        const moderator = yield* makeDevice(world.audience, "moderator");
        yield* moderator.signIn(world.session(mona));
        yield* moderator.client.subscribe(feed);
        yield* moderator.engine.pull;
        expect(idsOf(yield* moderator.stored)).not.toContain("a-draft");

        // A signs back in on the device: an account switch is a reset too, and A's draft is A's again.
        // (A fresh session: signing out invalidated the old one.)
        const back = yield* device.signIn(yield* world.audience.signIn(alice));
        expect(back.transition).toBe("Reset");
        expect(yield* device.stored).toEqual([]);
        expect(yield* device.client.quarantines).toEqual([]);
        expect(yield* device.store.pendingMutations).toHaveLength(1);
        yield* device.engine.push;
        yield* moderator.engine.pull;
        expect(idsOf(yield* moderator.stored)).toContain("a-draft");
      })
    )
  );
});
