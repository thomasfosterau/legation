/**
 * SpecExport
 *
 * Emit machine-readable API descriptions of an app's sync surface so bespoke
 * clients can be generated in any language (ADR-0017). The protocol is
 * schema-defined (Protocol.ts) and carrier-agnostic (ADR-0002); this module
 * turns those schemas — *specialized with the app's own collections, mutators
 * and queries* — into an OpenAPI document (the unary push/pull operations) and
 * an AsyncAPI document (push/pull plus the streamed poke channel).
 *
 * The value is specialization. The wire protocol moves `unknown` values and
 * args; a generic spec describes an opaque envelope. Here each message is
 * narrowed to a discriminated union over the app's actual names — a `Mutation`
 * per mutator (its `args` schema), a patch `Put` per collection (its row
 * schema), a named subscription per query — so a generated client gets
 * concrete, per-name types instead of `any`.
 *
 * The pipeline is two steps so new formats are cheap to add: `build` produces a
 * format-neutral {@link SyncSpec} (a shared JSON-Schema component pool plus the
 * names of each message), and the emitters (`toOpenApi`, `toAsyncApi`, or your
 * own) project that into a concrete document.
 *
 * The emitted OpenAPI is the protocol's *logical REST projection*: push and
 * pull as `POST {path}/push` and `POST {path}/pull`. The default RPC carrier
 * (RpcTransport.ts) multiplexes both over a single endpoint with its own
 * envelope; the projection is the codegen-friendly contract, equally servable
 * by a thin REST adapter.
 */

import { JsonSchema, Schema, type SchemaAST, SchemaRepresentation } from "effect";
import type * as Collection from "./Collection.js";
import type * as Mutator from "./Mutator.js";
import {
  MutationSchema,
  NamedSubscriptionSchema,
  PatchOpSchema,
  PokeSchema,
  PushResponseSchema,
} from "./Protocol.js";
import type * as Query from "./Query.js";
import { SubsetSchema } from "./Subset.js";

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Document metadata shared by every emitted format. */
export interface SpecInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/**
 * The app's sync surface to describe: its collections, mutators and queries.
 * All are optional — a read-only or write-only app still yields a valid spec —
 * and the protocol messages are always present.
 */
export interface SyncApi {
  readonly info: SpecInfo;
  readonly collections?: ReadonlyArray<Collection.AnyCollection>;
  readonly mutators?: ReadonlyArray<Mutator.AnyMutator>;
  readonly queries?: ReadonlyArray<Query.AnyQuery>;
  /** Base path the sync RPCs are served on. Defaults to `"/sync"`. */
  readonly path?: string;
}

// ─── Intermediate representation ───────────────────────────────────────────────

/** The component name an app type resolves to in the shared schema pool. */
export interface NamedSchema {
  readonly name: string;
  readonly schema: string;
}

/**
 * A format-neutral description of a sync surface: a shared component pool of
 * JSON Schemas (OpenAPI-style `#/components/schemas/...` refs) plus the
 * component name of each protocol message and app type. Emitters project this
 * into a concrete document; adding a format means adding a `toX(spec)`.
 */
export interface SyncSpec {
  readonly info: SpecInfo;
  readonly path: string;
  /** Shared JSON-Schema component pool (draft-2020-12, OpenAPI-style refs). */
  readonly components: JsonSchema.Definitions;
  /** Component name of each protocol message. */
  readonly messages: {
    readonly pushRequest: string;
    readonly pushResponse: string;
    readonly pullRequest: string;
    readonly pullResponse: string;
    readonly poke: string;
    readonly error: string;
  };
  /** App types, each with the component name of its specialized schema. */
  readonly catalog: {
    readonly collections: ReadonlyArray<NamedSchema>;
    readonly mutators: ReadonlyArray<NamedSchema>;
    readonly queries: ReadonlyArray<NamedSchema>;
  };
}

// ─── Component naming ──────────────────────────────────────────────────────────

/** Coerce an arbitrary name into a `$ref`-safe component identifier fragment. */
const sanitize = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return "x";
  return /^[0-9]/.test(cleaned) ? `n${cleaned}` : cleaned;
};

/** A namer that keeps identifiers unique by suffixing collisions (`_2`, `_3`). */
const uniqueNamer = () => {
  const seen = new Set<string>();
  return (prefix: string, name: string): string => {
    const base = `${prefix}${sanitize(name)}`;
    let candidate = base;
    let n = 2;
    while (seen.has(candidate)) candidate = `${base}_${n++}`;
    seen.add(candidate);
    return candidate;
  };
};

// ─── Specialized schemas ───────────────────────────────────────────────────────

const id = <S extends Schema.Top>(schema: S, identifier: string): S =>
  schema.annotate({ identifier }) as S;

/** The serializable failure carried on sync operations (RpcTransport's). */
const SyncErrorSchema = Schema.Struct({
  _tag: Schema.tag("SyncRpcError"),
  message: Schema.String,
});

/**
 * Build the specialized message schemas, each tagged with a stable component
 * identifier. Where the app provides names the generic `unknown` envelope is
 * narrowed to a discriminated union; otherwise the generic schema stands in.
 */
const specialize = (api: SyncApi) => {
  const collections = api.collections ?? [];
  const mutators = api.mutators ?? [];
  const queries = api.queries ?? [];
  const name = uniqueNamer();

  const collectionNames = collections.map((c) => ({ def: c, schema: name("Row_", c.name) }));
  const mutatorNames = mutators.map((m) => ({ def: m, schema: name("MutatorArgs_", m.name) }));
  const queryNames = queries.map((q) => ({ def: q, schema: name("QueryArgs_", q.name) }));

  // Mutation: one variant per mutator, discriminated by `mutator` name.
  const mutation =
    mutatorNames.length === 0
      ? id(MutationSchema, "Mutation")
      : id(
          Schema.Union(
            mutatorNames.map(({ def, schema }) =>
              id(
                Schema.Struct({
                  clientId: Schema.String,
                  mutationId: Schema.Number,
                  mutator: Schema.Literal(def.name),
                  args: id(def.args, schema),
                  createdAt: Schema.Number,
                }),
                `Mutation_${sanitize(def.name)}`
              )
            )
          ),
          "Mutation"
        );

  // PatchOp: a `Put` variant per collection (its row schema), plus Del/Clear.
  const patchOp =
    collectionNames.length === 0
      ? id(PatchOpSchema, "PatchOp")
      : id(
          Schema.Union([
            ...collectionNames.map(({ def, schema }) =>
              id(
                Schema.Struct({
                  _tag: Schema.tag("Put"),
                  collection: Schema.Literal(def.name),
                  id: Schema.String,
                  version: Schema.Union([Schema.String, Schema.Number]),
                  value: id(def.schema, schema),
                }),
                `Put_${sanitize(def.name)}`
              )
            ),
            Schema.Struct({
              _tag: Schema.tag("Del"),
              collection: Schema.String,
              id: Schema.String,
            }),
            Schema.Struct({ _tag: Schema.tag("Clear") }),
          ]),
          "PatchOp"
        );

  // NamedSubscription: one variant per query (its args schema).
  const namedSubscription =
    queryNames.length === 0
      ? id(NamedSubscriptionSchema, "NamedSubscription")
      : id(
          Schema.Union(
            queryNames.map(({ def, schema }) =>
              id(
                Schema.Struct({ name: Schema.Literal(def.name), args: id(def.args, schema) }),
                `NamedSubscription_${sanitize(def.name)}`
              )
            )
          ),
          "NamedSubscription"
        );

  const pushRequest = id(
    Schema.Struct({ clientGroupId: Schema.String, mutations: Schema.Array(mutation) }),
    "PushRequest"
  );
  const pullRequest = id(
    Schema.Struct({
      clientGroupId: Schema.String,
      cookie: Schema.optional(Schema.String),
      subscriptions: Schema.Array(id(SubsetSchema, "Subset")),
      namedSubscriptions: Schema.optional(Schema.Array(namedSubscription)),
    }),
    "PullRequest"
  );
  const pullResponse = id(
    Schema.Struct({
      cookie: Schema.String,
      patch: Schema.Array(patchOp),
      lastMutationIds: Schema.Record(Schema.String, Schema.Number),
    }),
    "PullResponse"
  );

  const roots: [SchemaAST.AST, ...Array<SchemaAST.AST>] = [
    pushRequest.ast,
    id(PushResponseSchema, "PushResponse").ast,
    pullRequest.ast,
    pullResponse.ast,
    id(PokeSchema, "Poke").ast,
    id(SyncErrorSchema, "SyncRpcError").ast,
  ];

  return {
    roots,
    catalog: {
      collections: collectionNames.map(({ def, schema }) => ({ name: def.name, schema })),
      mutators: mutatorNames.map(({ def, schema }) => ({ name: def.name, schema })),
      queries: queryNames.map(({ def, schema }) => ({ name: def.name, schema })),
    },
  };
};

// ─── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build the format-neutral {@link SyncSpec} from an app's sync surface. The
 * shared component pool is assembled once (so every message reuses the same
 * row/args definitions) in OpenAPI-style draft-2020-12.
 */
export const build = (api: SyncApi): SyncSpec => {
  const { roots, catalog } = specialize(api);
  const openApi = JsonSchema.toMultiDocumentOpenApi3_1(
    SchemaRepresentation.toJsonSchemaMultiDocument(SchemaRepresentation.toRepresentations(roots))
  );
  return {
    info: api.info,
    path: api.path ?? "/sync",
    components: openApi.definitions,
    messages: {
      pushRequest: "PushRequest",
      pushResponse: "PushResponse",
      pullRequest: "PullRequest",
      pullResponse: "PullResponse",
      poke: "Poke",
      error: "SyncRpcError",
    },
    catalog,
  };
};

// ─── Emitters ───────────────────────────────────────────────────────────────────

/** A JSON-serializable document (object form), as emitted by the projectors. */
export type Document = { readonly [key: string]: unknown };

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const msgRef = (name: string) => ({ $ref: `#/components/messages/${name}` });
const chanRef = (name: string) => ({ $ref: `#/channels/${name}` });
const message = (payload: string): Document => ({ name: payload, payload: ref(payload) });

const withDescription = (info: SpecInfo, extra: string): Document => ({
  title: info.title,
  version: info.version,
  description: info.description === undefined ? extra : `${info.description}\n\n${extra}`,
});

/**
 * Project a {@link SyncSpec} into an OpenAPI 3.1 document: push and pull as the
 * protocol's logical `POST {path}/push` and `POST {path}/pull` operations, with
 * every app type in `components.schemas`. Streamed pokes live in AsyncAPI.
 */
export const toOpenApi = (spec: SyncSpec): Document => {
  const operation = (
    operationId: string,
    summary: string,
    request: string,
    response: string
  ): Document => ({
    post: {
      operationId,
      summary,
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref(request) } },
      },
      responses: {
        "200": {
          description: "Success.",
          content: { "application/json": { schema: ref(response) } },
        },
        default: {
          description: "Sync error.",
          content: { "application/json": { schema: ref(spec.messages.error) } },
        },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: withDescription(
      spec.info,
      "Logical REST projection of the sync protocol. The default RPC carrier multiplexes push and pull over a single endpoint; these operations are the codegen-friendly contract."
    ),
    paths: {
      [`${spec.path}/push`]: operation(
        "push",
        "Deliver pending mutations (push).",
        spec.messages.pushRequest,
        spec.messages.pushResponse
      ),
      [`${spec.path}/pull`]: operation(
        "pull",
        "Request a patch to the next cookie (pull).",
        spec.messages.pullRequest,
        spec.messages.pullResponse
      ),
    },
    components: { schemas: spec.components },
  };
};

/**
 * Project a {@link SyncSpec} into an AsyncAPI 3.0 document: push and pull as
 * request/reply send operations and the contentless poke hint as a receive
 * channel. Component schemas are shared with the OpenAPI projection.
 */
export const toAsyncApi = (spec: SyncSpec): Document => {
  return {
    asyncapi: "3.0.0",
    info: withDescription(
      spec.info,
      "Message-oriented view of the sync protocol: push/pull request-reply and the streamed poke hint."
    ),
    channels: {
      push: {
        address: `${spec.path}/push`,
        messages: {
          request: msgRef(spec.messages.pushRequest),
          response: msgRef(spec.messages.pushResponse),
        },
      },
      pull: {
        address: `${spec.path}/pull`,
        messages: {
          request: msgRef(spec.messages.pullRequest),
          response: msgRef(spec.messages.pullResponse),
        },
      },
      pokes: {
        address: `${spec.path}/pokes`,
        messages: { poke: msgRef(spec.messages.poke) },
      },
    },
    operations: {
      push: {
        action: "send",
        channel: chanRef("push"),
        reply: { channel: chanRef("push"), messages: [msgRef(spec.messages.pushResponse)] },
      },
      pull: {
        action: "send",
        channel: chanRef("pull"),
        reply: { channel: chanRef("pull"), messages: [msgRef(spec.messages.pullResponse)] },
      },
      receivePokes: { action: "receive", channel: chanRef("pokes") },
    },
    components: {
      schemas: spec.components,
      messages: {
        [spec.messages.pushRequest]: message(spec.messages.pushRequest),
        [spec.messages.pushResponse]: message(spec.messages.pushResponse),
        [spec.messages.pullRequest]: message(spec.messages.pullRequest),
        [spec.messages.pullResponse]: message(spec.messages.pullResponse),
        [spec.messages.poke]: message(spec.messages.poke),
      },
    },
  };
};

// ─── Convenience ────────────────────────────────────────────────────────────────

/** Build and project to OpenAPI 3.1 in one step. */
export const openApi = (api: SyncApi): Document => toOpenApi(build(api));

/** Build and project to AsyncAPI 3.0 in one step. */
export const asyncApi = (api: SyncApi): Document => toAsyncApi(build(api));
