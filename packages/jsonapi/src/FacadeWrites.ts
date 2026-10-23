/**
 * FacadeWrites
 *
 * The pieces of a façade write (ADR-0030) that do not depend on the fetch
 * handler: reading the `Prefer` header (RFC 7240), decoding a write's body
 * **structurally** into a `JsonApiBackend.Write`, and the default **intent
 * mapping** from a `Write` to the graph-derived CRUD mutation the engine
 * journals (`CrudMutation`, graph row form). `JsonApiFacade` composes them.
 *
 * Structural means exactly ADR-0030 §5's list: `data` is an object whose
 * `type` is the route's, whose `id` (when present) is the path's for a
 * `PATCH`, whose `attributes` / `relationships` are objects when present, and
 * whose relationships are `one` edges of the node with `{ type, id }` or
 * `null` linkage. Attribute values are never checked: the server rules on
 * them, and a value it refuses surfaces as a permanent rejection.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { CrudMutation } from "@thomasfosterau/legation-effect";
import type { Node } from "@thomasfosterau/legation-effect";
import type { Write } from "./JsonApiBackend.js";

// ─── Prefer ──────────────────────────────────────────────────────────────────

/** The preferences a façade write reads from `Prefer` (RFC 7240 §4); others are forwarded untouched. */
export interface Preferences {
  /** `Prefer: respond-async`: journal and answer a receipt even when online. */
  readonly respondAsync: boolean;
  /** `Prefer: handling=strict`: never journal. */
  readonly strict: boolean;
  /** `Prefer: wait=N`, in seconds, when present and a non-negative integer. */
  readonly wait?: number;
}

/** Read the `Prefer` headers of a request (several headers and comma-separated lists alike). */
export const preferencesOf = (headers: Headers): Preferences => {
  const pairs = Arr.map((headers.get("prefer") ?? "").split(","), (part) => {
    const [token = ""] = part.split(";");
    const [rawName = "", ...rest] = token.split("=");
    const value = rest
      .join("=")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    return [rawName.trim().toLowerCase(), value] as const;
  });
  const has = (name: string, value?: string) =>
    Arr.some(pairs, ([n, v]) => n === name && (value === undefined || v === value));
  const wait = Arr.findLast(pairs, ([n, v]) => n === "wait" && /^\d+$/.test(v));
  const preferences = { respondAsync: has("respond-async"), strict: has("handling", "strict") };
  return Option.match(wait, {
    onNone: () => preferences,
    onSome: ([, v]) => ({ ...preferences, wait: Number(v) }),
  });
};

// ─── Decoding ────────────────────────────────────────────────────────────────

/**
 * Why a write's body cannot be journaled, as the error object an offline
 * façade answers with (ADR-0030 §3): `400 invalid_document`, `409
 * type_mismatch` / `id_mismatch`, `422 unsupported_relationship`, or the
 * `client_id_required` a `POST` without an id meets.
 */
export interface Refusal {
  readonly status: 400 | 409 | 422 | 503;
  readonly code:
    | "invalid_document"
    | "type_mismatch"
    | "id_mismatch"
    | "unsupported_relationship"
    | "client_id_required";
  readonly title: string;
  readonly detail: string;
  readonly pointer?: string;
}

const refuse = (refusal: Refusal): Effect.Effect<never, Refusal> => Effect.fail(refusal);

const invalid = (detail: string, pointer: string): Effect.Effect<never, Refusal> =>
  refuse({ status: 400, code: "invalid_document", title: "Invalid document", detail, pointer });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  P.isObject(value) && !Array.isArray(value);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** What a write route matched: its operation, the route's type, and the path's id for `PATCH` / `DELETE`. */
export type Target =
  | { readonly operation: "create"; readonly type: string }
  | { readonly operation: "update" | "delete"; readonly type: string; readonly id: string };

/** The linkage of one relationship: a related id, `null`, or a refusal. */
const linkageOf = (
  name: string,
  member: unknown,
  node: Node.AnyNode
): Effect.Effect<string | null, Refusal> => {
  const pointer = `/data/relationships/${name}`;
  const edge = node.edges[name];
  if (edge === undefined || edge.kind !== "one") {
    return refuse({
      status: 422,
      code: "unsupported_relationship",
      title: "Unsupported relationship",
      detail:
        edge === undefined
          ? `"${name}" is not a relationship of ${node.type}`
          : `"${name}" is a to-many relationship; its linkage lives on the related resources, not on ${node.type}`,
      pointer,
    });
  }
  if (!isRecord(member) || !("data" in member)) {
    return invalid(`relationship "${name}" must be an object with a "data" member`, pointer);
  }
  const data = member["data"];
  if (data === null) return Effect.succeed(null);
  if (!isRecord(data) || !P.isString(data["id"]) || data["type"] !== edge.target) {
    return invalid(
      `relationship "${name}" must link one "${edge.target}" by type and id, or be null`,
      `${pointer}/data`
    );
  }
  return Effect.succeed(data["id"]);
};

/**
 * Decode a write's body structurally into a `Write` whose `relationships`
 * are flattened into `one`-edge ids by relationship name (`null` clears).
 * A `DELETE` reads no body. Fails with the {@link Refusal} the offline façade
 * answers with.
 */
export const decodeWrite = (
  node: Node.AnyNode,
  target: Target,
  body: Effect.Effect<string, unknown>
): Effect.Effect<Write, Refusal> =>
  Effect.gen(function* () {
    if (target.operation === "delete") {
      return { operation: "delete", type: target.type, id: target.id };
    }
    const text = yield* body.pipe(
      Effect.catch(() => invalid("the request body could not be read", ""))
    );
    const document = yield* decodeJson(text).pipe(
      Effect.catch(() => invalid("the request body is not JSON", ""))
    );
    if (!isRecord(document) || !("data" in document)) {
      return yield* invalid('a write document needs a "data" member', "");
    }
    const data = document["data"];
    if (!isRecord(data)) return yield* invalid('"data" must be a resource object', "/data");
    if (data["type"] !== target.type) {
      return yield* refuse({
        status: 409,
        code: "type_mismatch",
        title: "Type mismatch",
        detail: `this endpoint writes "${target.type}" resources`,
        pointer: "/data/type",
      });
    }
    const id = data["id"];
    if (id !== undefined && !P.isString(id)) {
      return yield* invalid('"data.id" must be a string', "/data/id");
    }
    if (target.operation === "update" && id === undefined) {
      return yield* invalid("an update's data needs the id the path names", "/data/id");
    }
    if (target.operation === "update" && id !== target.id) {
      return yield* refuse({
        status: 409,
        code: "id_mismatch",
        title: "Id mismatch",
        detail: `"data.id" must be the id the path names ("${target.id}")`,
        pointer: "/data/id",
      });
    }
    const attributes = data["attributes"] ?? {};
    if (!isRecord(attributes)) {
      return yield* invalid('"data.attributes" must be an object', "/data/attributes");
    }
    const relationships = data["relationships"] ?? {};
    if (!isRecord(relationships)) {
      return yield* invalid('"data.relationships" must be an object', "/data/relationships");
    }
    const linkage = yield* Effect.forEach(
      R.toEntries(relationships),
      ([name, member]) =>
        Effect.map(linkageOf(name, member, node), (related) => [name, related] as const),
      { concurrency: 1 }
    );
    const resolved = target.operation === "create" ? id : target.id;
    if (resolved === undefined || resolved === "") {
      return yield* refuse({
        status: 503,
        code: "client_id_required",
        title: "Client id required",
        detail: "A create the façade journals offline needs a client-generated id in data.id.",
        pointer: "/data/id",
      });
    }
    return {
      operation: target.operation,
      type: target.type,
      id: resolved,
      attributes,
      relationships: R.fromEntries(linkage),
    };
  });

// ─── The intent mapping ──────────────────────────────────────────────────────

/** The mutation a write is journaled as: a registered mutator name and its encoded args. */
export interface Intent {
  readonly mutator: string;
  readonly args: unknown;
}

/**
 * The intent mapping (ADR-0030 §5): a decoded `Write` to the mutation the
 * engine journals, or `undefined` when the write is not interceptable.
 * `relationships` arrive flattened by {@link decodeWrite}: relationship name
 * to related id (or `null`).
 */
export type IntentOf = (write: Write) => Intent | undefined;

/**
 * The default intent mapping: the graph-derived CRUD mutations
 * (`CrudMutation`), args in the graph row form — the attributes plus, per
 * `one` edge the payload links, its `via` key.
 */
export const graphIntentOf =
  (nodes: Node.NodeRegistry): IntentOf =>
  (write) => {
    const node = nodes.nodes.get(write.type);
    if (node === undefined) return undefined;
    const mutator = CrudMutation.name(write.type, write.operation);
    if (write.operation === "delete") return { mutator, args: { type: write.type, id: write.id } };
    const linked = Arr.map(R.toEntries(write.relationships ?? {}), ([name, related]) => {
      const edge = node.edges[name];
      return edge?.kind === "one" ? Option.some([edge.via, related] as const) : Option.none();
    });
    const vias = Option.all(linked);
    if (Option.isNone(vias)) return undefined;
    const attributes = { ...write.attributes, ...R.fromEntries(vias.value) };
    return { mutator, args: { type: write.type, id: write.id, attributes } };
  };
