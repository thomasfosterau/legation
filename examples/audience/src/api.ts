/**
 * The audience JSON:API (`@thomasfosterau/effect-jsonapi`): one resource,
 * `posts`, read by `GET /jsonapi/posts` and `GET /jsonapi/posts/:id`.
 *
 * Both endpoints are declared with the node graph's own codec
 * (`JsonApiQuery.querySchema` / `singleRowSchema`), so the server's derived
 * handlers (`RestHandlers`, in `server.ts`) and the client's façade
 * (`JsonApiFacade`, in `device.ts`) parse a URL under one grammar — the
 * parity ADR-0029 §6 presumes — and write it through one serialiser.
 */
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import { ApiError, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi";
import { JsonApiQuery } from "@thomasfosterau/legation-jsonapi";
import { nodes } from "./domain.js";

/** A post as a JSON:API resource: the node's attributes, absent under a sparse fieldset. */
export const Post = Resource.make("posts", {
  attributes: {
    ownerId: Resource.attribute(Schema.String, { resource: "optional", filter: ["eq"] }),
    visibility: Resource.attribute(Schema.String, { resource: "optional", filter: ["eq"] }),
    body: Resource.attribute(Schema.String, { resource: "optional" }),
  },
});

/** The resources the endpoints are declared with, by type: what linkage follows on both sides. */
export const resources: ReadonlyMap<string, Resource.Any> = new Map([[Post.type, Post]]);

export class NotFound extends ApiError.make<NotFound>()("NotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
}) {}

export const api = HttpApi.make("audience")
  .add(
    Group.make(
      Post,
      Endpoint.list(Post, { query: JsonApiQuery.querySchema(nodes, "posts") }),
      Endpoint.get(Post, {
        query: JsonApiQuery.singleRowSchema(nodes, "posts"),
        errors: [NotFound],
      })
    )
  )
  .prefix("/jsonapi");
