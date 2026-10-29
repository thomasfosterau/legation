/**
 * The inverse intent codec (ADR-0030 §5, #529): `FacadeWrites.writesOf` turns
 * the graph-derived CRUD mutations' args back into JSON:API writes, each `one`
 * edge's `via` key rebuilt as the relationship's linkage, so a `JsonApiBackend`
 * over a node-graph app replays a façade-journaled write as the request the app
 * would have sent.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CrudMutation, Edge, Node } from "@thomasfosterau/legation-effect";
import type { ResourceMap } from "../Convention.js";
import * as FacadeWrites from "../FacadeWrites.js";
import * as JsonApiBackend from "../JsonApiBackend.js";

const categories = Node.make("categories", { attributes: { name: Schema.String } });
const notes = Node.make("notes", {
  attributes: { title: Schema.String },
  edges: { category: Edge.one("categories", { via: "categoryId" }) },
});
const nodes = Node.registry([categories, notes]);

const intentOf = FacadeWrites.graphIntentOf(nodes);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const writes = FacadeWrites.writesOf(nodes);

/** Map a structural write through the façade's intent and back. */
const roundTrip = (write: JsonApiBackend.Write) =>
  Option.fromUndefinedOr(intentOf(write)).pipe(
    Option.flatMap((intent) =>
      Option.map(Option.fromUndefinedOr(writes.get(intent.mutator)), (inverse) =>
        inverse(intent.args)
      )
    )
  );

describe("FacadeWrites.writesOf (#529)", () => {
  it("is the inverse of graphIntentOf, with each via key rebuilt as linkage", () => {
    expect(
      roundTrip({
        operation: "create",
        type: "notes",
        id: "n-1",
        attributes: { title: "Hello" },
        relationships: { category: "c-1" },
      })
    ).toEqual(
      Option.some({
        operation: "create",
        type: "notes",
        id: "n-1",
        attributes: { title: "Hello" },
        relationships: { category: { data: { type: "categories", id: "c-1" } } },
      })
    );
    // A cleared relationship is `null` linkage; an unlinked one stays out.
    expect(
      roundTrip({
        operation: "update",
        type: "notes",
        id: "n-1",
        attributes: { title: "Renamed" },
        relationships: { category: null },
      })
    ).toEqual(
      Option.some({
        operation: "update",
        type: "notes",
        id: "n-1",
        attributes: { title: "Renamed" },
        relationships: { category: { data: null } },
      })
    );
    expect(
      roundTrip({ operation: "update", type: "notes", id: "n-1", attributes: { title: "T" } })
    ).toEqual(
      Option.some({
        operation: "update",
        type: "notes",
        id: "n-1",
        attributes: { title: "T" },
        relationships: {},
      })
    );
    expect(roundTrip({ operation: "delete", type: "notes", id: "n-1" })).toEqual(
      Option.some({ operation: "delete", type: "notes", id: "n-1" })
    );
  });

  it("writes only the mutation's own type: args naming another are refused", () => {
    const create = writes.get("notes/create");
    const remove = writes.get("notes/delete");
    expect(() =>
      create?.({ type: "categories", id: "c-1", attributes: { name: "forged" } })
    ).toThrow(FacadeWrites.InvalidWriteArgs);
    expect(() => remove?.({ type: "categories", id: "c-1" })).toThrow(/writes "notes"/);
    expect(create?.({ type: "notes", id: "n-1", attributes: { title: "T" } })?.type).toBe("notes");
  });

  it("covers every derived mutation, and only those `writes` selects", () => {
    expect([...writes.keys()].toSorted()).toEqual(
      [
        "categories/create",
        "categories/delete",
        "categories/update",
        "notes/create",
        "notes/delete",
        "notes/update",
      ].toSorted()
    );
    expect([...FacadeWrites.writesOf(nodes, { writes: { notes: ["create"] } }).keys()]).toEqual([
      "notes/create",
    ]);
  });
});

/** One endpoint of the notes resource. */
const ref = (method: string, path: string) => ({
  groupId: "notes",
  name: method,
  method,
  path,
});

describe("a JsonApiBackend over a node-graph app (#529)", () => {
  it.effect("replays a façade-journaled create as the POST the app would send", () =>
    Effect.gen(function* () {
      const sent: Array<{ readonly method: string; readonly url: string; readonly body: string }> =
        [];
      const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          sent.push({ method: request.method, url: url.pathname, body });
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status: 201,
              headers: { "Content-Type": "application/vnd.api+json" },
            })
          );
        })
      );
      const resources: ResourceMap = new Map([
        [
          "notes",
          {
            type: "notes",
            create: ref("POST", "/notes"),
            update: ref("PATCH", "/notes/:id"),
            delete: ref("DELETE", "/notes/:id"),
          },
        ],
      ]);
      const backend = yield* JsonApiBackend.make({
        baseUrl: "http://api.test",
        resources,
        mutators: CrudMutation.registry(nodes).mutators,
        operations: new Map(),
        writes,
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)));

      // What the façade journals for a POST /notes with a category linkage.
      const intent = intentOf({
        operation: "create",
        type: "notes",
        id: "n-1",
        attributes: { title: "Hello" },
        relationships: { category: "c-1" },
      });
      expect(intent?.mutator).toBe("notes/create");
      yield* backend.applyMutations({ clientGroupId: "g" }, [
        { clientId: "c", mutationId: 1, mutator: "notes/create", args: intent?.args, createdAt: 0 },
      ]);

      expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /notes"]);

      // A forged mutation: authorised as `notes/create`, its args name another
      // type. The push fails as invalid args, and nothing reaches the server.
      const forged = yield* Effect.exit(
        backend.applyMutations({ clientGroupId: "g" }, [
          {
            clientId: "c",
            mutationId: 2,
            mutator: "notes/create",
            args: { type: "categories", id: "c-9", attributes: { name: "forged" } },
            createdAt: 0,
          },
        ])
      );
      expect(Exit.isFailure(forged)).toBe(true);
      // A failure (the BackendError of invalid args), not a defect.
      const reason = Exit.isFailure(forged) ? forged.cause.reasons[0] : undefined;
      expect(reason?._tag === "Fail" && reason.error._tag).toBe("BackendError");
      expect(sent).toHaveLength(1);
      expect(decodeJson(sent[0]?.body ?? "{}")).toEqual({
        data: {
          type: "notes",
          id: "n-1",
          attributes: { title: "Hello" },
          relationships: { category: { data: { type: "categories", id: "c-1" } } },
        },
      });
    })
  );
});
