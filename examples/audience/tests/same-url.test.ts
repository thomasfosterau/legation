/**
 * Test 3 of #221 — same URL, same answer (ADR-0029 §6): for one signed-in
 * viewer, a JSON:API `GET` answered by the façade from the viewer's replica
 * and the same `GET` answered by the server's derived REST handler, under
 * the viewer's session cookie, are the same document, byte for byte. Both
 * resolve the cookie with the one `Resolver`, compile the one effect-auth
 * policy into the one auth filter, and write through the one serialiser.
 *
 * The tests run on the live clock: the web handler runs in its own runtime,
 * so a session minted under a test clock would be expired there.
 *
 * And where the replica cannot answer — a row the viewer may not read — the
 * façade does not invent one: it forwards, and the server answers 404.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { feed } from "../src/domain.js";
import { makeDevice } from "../src/device.js";
import { cookieHeader, type Session } from "../src/server.js";
import { alice, bob, carol, makeSeededWorld, mona, type World } from "./support/world.js";

type Json = any;

const ORIGIN = "http://audience.test";

const jsonApi = (path: string, session?: Session) =>
  new Request(`${ORIGIN}${path}`, {
    headers: {
      accept: "application/vnd.api+json",
      ...(session === undefined ? {} : { cookie: cookieHeader(session.token) }),
    },
  });

/** The server's answer to a path, as the viewer's browser would send it. */
const served = (world: World, path: string, session: Session) =>
  Effect.promise(async () => {
    const response = await world.audience.fetch(jsonApi(path, session));
    return { status: response.status, text: await response.text() };
  });

/** The URLs every viewer's feed pin covers: the collection, narrowed, projected, paged, and one row. */
const urls = [
  "/jsonapi/posts",
  "/jsonapi/posts?filter[visibility]=followers",
  `/jsonapi/posts?filter[ownerId]=${alice.id}`,
  "/jsonapi/posts?fields[posts]=body&sort=id",
  "/jsonapi/posts?sort=id&page[limit]=2",
  "/jsonapi/posts/a-public",
];

describe("the façade and the derived REST handler agree for the same signed-in viewer", () => {
  it.live("answers every covered URL with the server's document, byte for byte", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        for (const user of [alice, bob, carol, mona]) {
          const session = world.session(user);
          const device = yield* makeDevice(world.audience, `same-url-${user.id}`);
          yield* device.signIn(session);
          yield* device.client.subscribe(feed);
          yield* device.engine.pull;
          for (const url of urls) {
            // The browser's own request: the façade never needs its cookie.
            const request = jsonApi(url);
            expect(device.facade.matches(request), url).toBe(true);
            const local = yield* device.facade.handle(request);
            expect(local, `${user.id} ${url}`).toBeDefined();
            expect(local!.status, url).toBe(200);
            expect(local!.headers.get("x-legation-served-at"), url).toBe(
              yield* device.store.getCookie
            );
            const remote = yield* served(world, url, session);
            expect(remote.status, url).toBe(200);
            expect(yield* Effect.promise(() => local!.text()), `${user.id} ${url}`).toBe(
              remote.text
            );
          }
          // The listing really is the viewer's: the server scoped it, the replica agrees.
          const listing = JSON.parse(
            (yield* served(world, "/jsonapi/posts", session)).text
          ) as Json;
          expect(listing.meta.total, user.id).toBe(listing.data.length);
        }
      })
    )
  );

  it.live("forwards a row the viewer may not read, and the server answers 404", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeSeededWorld;
        const session = world.session(carol);
        const device = yield* makeDevice(world.audience, "same-url-forward");
        yield* device.signIn(session);
        yield* device.client.subscribe(feed);
        yield* device.engine.pull;
        for (const url of ["/jsonapi/posts/a-private", "/jsonapi/posts/a-followers"]) {
          expect(yield* device.facade.handle(jsonApi(url)), url).toBeUndefined();
          expect((yield* served(world, url, session)).status, url).toBe(404);
        }
        // The owner reads the same URL.
        expect(
          (yield* served(world, "/jsonapi/posts/a-private", world.session(alice))).status
        ).toBe(200);
        // A listing filtered to what the viewer may not read is empty on both sides.
        const hidden = "/jsonapi/posts?filter[visibility]=private&filter[ownerId]=user-alice";
        const local = yield* device.facade.handle(jsonApi(hidden));
        const remote = yield* served(world, hidden, session);
        expect(yield* Effect.promise(() => local!.text())).toBe(remote.text);
        expect((JSON.parse(remote.text) as Json).data).toEqual([]);
      })
    )
  );
});
