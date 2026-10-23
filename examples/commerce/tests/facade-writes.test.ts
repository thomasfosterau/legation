/**
 * The façade's writes over the real stack (ADR-0030, #510): the commerce
 * façade (`src/lib/facade.ts`) over an engine synced with the SQLite server
 * (`syncLayer`), the client group bound to a signed-in user, the shell's pins
 * applied. Offline, a plain-fetch `POST /jsonapi/reviews` with a client id is
 * journaled as the graph-derived `reviews/create` and answered `202`; a
 * covered read shows the review at once; on push the server's
 * `reviews/create` handler rules on it under `review/write`'s rules —
 * acknowledged with the author set from identity, or permanently rejected
 * ("rating out of range"), after which the review leaves covered reads.
 *
 * The browser half (the worker's listener, the clone it keeps before
 * forwarding) is wired in `src/service-worker.ts`; this test drives the
 * façade directly, as `replica-documents.test.ts` does for reads.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, HashMap, Layer, Option, Stream } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Client, ClientStore, Transport } from "@thomasfosterau/legation-effect";
import { ClientEngine, ClientView } from "@thomasfosterau/legation-effect/internal";
import { JsonApiQuery } from "@thomasfosterau/legation-jsonapi";
import { mutators, nodes, shellReads } from "../src/lib/domain.js";
import { makeFacade } from "../src/lib/facade.js";
import { migrate } from "../server/db.js";
import { bindClientGroup, syncLayer } from "../server/runtime.js";

const USER = "u1";
const GROUP = "group-u1";
const MEDIA = "application/vnd.api+json";

const makeWorld = Effect.gen(function* () {
  const context = yield* Layer.build(
    syncLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  );
  const sql = Context.get(context, SqlClient);
  yield* migrate.pipe(Effect.provideService(SqlClient, sql));
  yield* bindClientGroup(GROUP, USER).pipe(Effect.provideService(SqlClient, sql));
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(
    Context.get(context, Transport.ServerHandler),
    GROUP
  );
  const engine = yield* ClientEngine.make({ clientId: "sw-u1", clientGroupId: GROUP, mutators }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  const client = Client.fromView(nodes, ClientView.fromEngine(engine), {
    urls: JsonApiQuery.urlReads(nodes),
  });
  yield* Effect.forEach(shellReads(USER), (read) => client.subscribe(read), { discard: true });
  yield* engine.pull;
  const online = { current: false };
  const facade = makeFacade({
    view: client.view,
    coverageOf: client.coverageOf,
    cookie: store.getCookie,
    online: () => online.current,
    mutate: engine.mutateWithAck,
    pull: engine.pull,
    mutationStates: engine.mutationStates,
  });
  const serverReview = (id: string) =>
    sql<{ userId: string; rating: number }>`SELECT userId, rating FROM reviews WHERE id = ${id}`;
  const phaseOf = (mutationId: number) =>
    Stream.runHead(engine.mutationStates).pipe(
      Effect.map((map) =>
        Option.flatMap(map, (states) => HashMap.get(states, mutationId)).pipe(
          Option.map((state) => ({ phase: state.phase, reason: state.reason }))
        )
      )
    );
  return { facade, engine, online, serverReview, phaseOf };
}).pipe(Effect.orDie);

const postReview = (id: string, rating: number, headers: Record<string, string> = {}) =>
  new Request("http://commerce.test/jsonapi/reviews", {
    method: "POST",
    headers: { accept: MEDIA, "content-type": MEDIA, ...headers },
    body: JSON.stringify({
      data: {
        type: "reviews",
        id,
        attributes: {
          authorName: "Ana",
          rating,
          body: "Offline thoughts.",
          createdAt: "2026-09-04T09:00:00Z",
        },
        relationships: { product: { data: { type: "products", id: "p-01" } } },
      },
    }),
  });

const reviewsOfP01 = new Request(
  "http://commerce.test/jsonapi/reviews?filter[productId]=p-01&sort=-createdAt",
  { headers: { accept: MEDIA } }
);

const json = (response: Response) => Effect.promise(() => response.json() as Promise<any>);

describe("the commerce façade's writes (ADR-0030, #510)", () => {
  it.effect("journals an offline review, shows it, and the server acknowledges it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { facade, engine, serverReview, phaseOf } = yield* makeWorld;
        const response = yield* facade.handle(postReview("r-off-1", 5));
        expect(response?.status).toBe(202);
        const receipt = yield* json(response!);
        expect(receipt.meta.legation.status).toBe("pending");
        expect(response!.headers.get("location")).toBe(
          `/jsonapi/_legation/mutations/${receipt.meta.legation.mutationId}`
        );
        expect(receipt.data).toMatchObject({
          type: "reviews",
          id: "r-off-1",
          attributes: { authorName: "Ana", rating: 5 },
          relationships: { product: { data: { type: "products", id: "p-01" } } },
        });
        // A covered read shows it before the server has ruled.
        const listed = yield* facade.handle(reviewsOfP01);
        expect(listed?.status).toBe(200);
        const ids = ((yield* json(listed!)).data as ReadonlyArray<{ id: string }>).map((r) => r.id);
        expect(ids[0]).toBe("r-off-1");
        expect(yield* serverReview("r-off-1")).toEqual([]);
        // Back online: the push delivers `reviews/create`; the author is the caller.
        yield* engine.push;
        expect(yield* serverReview("r-off-1")).toEqual([{ userId: USER, rating: 5 }]);
        expect(yield* phaseOf(receipt.meta.legation.mutationId)).toEqual(
          Option.some({ phase: "acknowledged", reason: undefined })
        );
      })
    )
  );

  it.effect("a review the server refuses is rejected with its reason and leaves covered reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { facade, engine, serverReview, phaseOf } = yield* makeWorld;
        const response = yield* facade.handle(postReview("r-off-2", 7));
        expect(response?.status).toBe(202);
        const { mutationId } = (yield* json(response!)).meta.legation;
        yield* engine.push;
        yield* engine.pull;
        expect(yield* serverReview("r-off-2")).toEqual([]);
        expect(yield* phaseOf(mutationId)).toEqual(
          Option.some({ phase: "rejected", reason: "rating out of range" })
        );
        // The receipt's `Location` is where a plain-fetch caller reads the ruling (ADR-0030 §2).
        const status = yield* facade.handle(
          new Request(`http://commerce.test${response!.headers.get("location")}`, {
            headers: { accept: MEDIA },
          })
        );
        expect(status?.status).toBe(200);
        expect((yield* json(status!)).data.attributes).toMatchObject({
          phase: "rejected",
          mutator: "reviews/create",
          reason: "rating out of range",
        });
        const listed = yield* facade.handle(reviewsOfP01);
        const ids = ((yield* json(listed!)).data as ReadonlyArray<{ id: string }>).map((r) => r.id);
        expect(ids).not.toContain("r-off-2");
      })
    )
  );

  it.effect("only the writes `facadeWrites` declares are intercepted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { facade } = yield* makeWorld;
        const cartLine = new Request("http://commerce.test/jsonapi/cartItems", {
          method: "POST",
          headers: { accept: MEDIA, "content-type": MEDIA },
          body: JSON.stringify({ data: { type: "cartItems", id: "ci-9", attributes: { qty: 1 } } }),
        });
        expect(facade.matches(postReview("r-x", 5))).toBe(true);
        expect(facade.matches(cartLine)).toBe(false);
      })
    )
  );
});
