/**
 * JsonApiBackend
 *
 * An implementation of the core `Backend` contract (ADR-0009) backed by a
 * JSON:API HTTP surface instead of app-owned storage. This is what lets the
 * library "figure out the sync story" from a plain REST API: the sync server
 * (in-process for the client-direct happy path) drives this backend's three
 * operations, and the existing engine supplies journal, overlay, rebase, and
 * CVR diffing on top.
 *
 * Mapping:
 * - `evaluate` lists the collection (`GET /{type}`), pushing the whole
 *   predicate to the server as the filter grammar's canonical `filter[...]`
 *   form via the `QueryEncoder` (exact under ADR-0028; a predicate that can
 *   never match skips the request) and applying predicate, order and limit
 *   locally with `Subset.apply` — the window is local, and re-running the
 *   filter is redundancy over an exact server answer, not correction.
 *   With `includes`, it adds `?include=...` and harvests the compound document's
 *   related rows, serving auto-subscribed `id IN (...)` subsets from that cache.
 * - `getRows` serves row values from the cache `evaluate` populates (the sync
 *   server always evaluates before fetching put rows in the same pull),
 *   falling back to `GET /{type}/{id}`.
 * - `applyMutations` replays the batch as HTTP writes. Each mutation is one
 *   JSON:API write (`Write`: a create, update or delete of one resource —
 *   derived CRUD mutators map directly, and `writes` expresses custom
 *   mutators). With `atomic` configured the whole batch goes as one
 *   `atomic:operations` request (`create` → `add`, `update` → `update`,
 *   `delete` → `remove`, sent with the extension's media type); otherwise
 *   each write is its own `POST`/`PATCH`/`DELETE`.
 *
 * **Versioning.** A plain REST API exposes no row-version token, so versions
 * are a content hash of the resource value: the hash changes iff the row
 * changed, which is exactly what CVR diffing needs.
 *
 * **Change hints.** A push's hints carry each touched row's pre-push value as
 * `oldValues`, as MemoryBackend's do, so topic-derived fan-out (ADR-0023) pokes
 * the windows a row moved away from. A REST API keeps no change token, and
 * nothing here says whether a cached row is still current (a write made
 * elsewhere goes unseen, and this backend's own writes do not refresh its
 * cache), so the old value is always read: each update or delete does one
 * `GET /{type}/{id}` before its write, once per row per push. A row the push
 * creates was absent before the push, so it is not read (`enterBatchCreate`),
 * unless the server refuses the create and a later write of the row needs its
 * value (`readRefusedCreates`, #402). Every failed read fails the push with
 * BackendError, a 4xx and a 404 included, and so does a 2xx with no resource, so
 * an update or delete is either sent with its old value or not sent. On the
 * atomic path nothing has been written by then, so the retry reads again. On the
 * per-resource path the writes before the failed read have already applied and
 * been acknowledged, so the retry does not resend them
 * and their hints are lost: the at-least-once delivery described below, as for
 * any transient write failure there. A read the server refuses (a 4xx) stalls
 * that client's queue until the refusal is resolved. A resource that receives
 * updates or deletes needs a `getOne` route: without one each of its updates
 * and deletes fails its push, before anything is written. The new value of a
 * create or update is the server's returned document when it sends one, else
 * the row read before the push merged with the write (so a partial PATCH hints
 * the full row), else the written value.
 *
 * **Delivery semantics.** Without a cooperating server there is no
 * server-side mutation-id ledger, so this backend keeps an in-session ledger.
 *
 * Over an atomic operations endpoint (`atomic` set) a push is all-or-nothing
 * per batch: one request, and the ledger advances only once the server has
 * applied every operation in it. A transient failure — transport, 5xx, or a
 * 4xx naming no operation — leaves the server holding nothing and the ledger
 * unmoved, so the client's retry resends the same batch. A 4xx error document
 * whose `source.pointer` names an operation (`Atomic.operationPointer(i)`) is
 * a permanent rejection of that mutation (ADR-0008's poison-mutation
 * semantics): it is recorded as rejected and the batch is resent without it,
 * until the remainder applies or nothing is left; every mutation in the batch
 * is then acknowledged in order (one round trip per rejection, bounded by the
 * batch size). `lid` is supported by the wire format but unused: derived
 * creates carry the client-generated `id`, and no mutator yet needs a
 * server-assigned one.
 *
 * Over per-resource endpoints (no `atomic`) delivery is *at-least-once*:
 * make writes idempotent (client-generated ids on create; PATCH/DELETE are
 * naturally idempotent) and retries are safe.
 */

import { Effect, Option, Ref, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Atomic } from "@thomasfosterau/effect-jsonapi";
import {
  Backend,
  BackendError,
  MutationRejected,
  Predicate,
} from "@thomasfosterau/legation-effect";
import { Hash, Protocol, UnknownMutator } from "@thomasfosterau/legation-effect/internal";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import type { Mutator } from "@thomasfosterau/legation-effect";
import {
  documentToRows,
  parseResponse,
  resourceToRow,
  type RelationshipRef,
} from "./CollectionLoader.js";
import type { ResourceMap } from "./Convention.js";
import { toRow, type JsonApiRow, type OperationInfo } from "./Derive.js";
import { defaultEncoder, type QueryEncoder } from "./JsonApiQuery.js";
import { ResourceObjectSchema } from "./schema.js";
import type { ResourceObject } from "./types.js";

/**
 * One JSON:API write — the unit both delivery paths speak: a create (`POST`,
 * or atomic `add`), update (`PATCH` / `update`) or delete (`DELETE` /
 * `remove`) of one resource. Creates carry the client-generated id.
 */
export interface Write {
  readonly operation: "create" | "update" | "delete";
  readonly type: string;
  readonly id: string;
  readonly attributes?: Record<string, unknown>;
  readonly relationships?: Record<string, unknown>;
}

/** Configuration for {@link make}. */
export interface JsonApiBackendConfig {
  /** Base URL the resource paths are resolved against (no trailing slash). */
  readonly baseUrl: string;
  readonly resources: ResourceMap;
  /** Mutator definitions, for decoding/validating pushed args. */
  readonly mutators: ReadonlyMap<string, Mutator.AnyMutator>;
  /** Mutator name → CRUD operation + type. */
  readonly operations: ReadonlyMap<string, OperationInfo>;
  /**
   * Mutators beyond the derived CRUD ones, and how to express each one's
   * decoded args as a single JSON:API `Write`. Consulted before `operations`,
   * so an app can push its own named intents through this backend as long
   * as each is one create/update/delete of one resource.
   */
  readonly writes?: ReadonlyMap<string, (args: unknown) => Write>;
  /**
   * The server's JSON:API Atomic Operations endpoint (`POST {path}`), when it
   * has one. With it set, `applyMutations` pushes a whole batch as one
   * all-or-nothing `atomic:operations` request; without it, each mutation is
   * its own request. `JsonApiSync` fills this in from the reflected api
   * (`Convention.reflectAtomic`).
   */
  readonly atomic?: { readonly path: string };
  /** Subset → JSON:API query string. Defaults to the exact filter-grammar encoder. */
  readonly query?: QueryEncoder;
  /**
   * Relationship names to compound-load per collection (`?include=...`). When a
   * listing pulls in related resources, they are harvested so an auto-subscribed
   * `id IN (...)` subset over those collections is served from the same response
   * — no extra round trip. See `Relationships.related`.
   */
  readonly includes?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** A mutation as the sync server pushes it to a backend. */
type PushedMutation = Protocol.Mutation;

const jsonApiHeaders = {
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
} as const;

/** The extension media type an atomic operations request carries both ways. */
const atomicHeaders = {
  "Content-Type": Atomic.MEDIA_TYPE,
  Accept: Atomic.MEDIA_TYPE,
} as const;

const trimSlashes = (s: string): string => s.replace(/\/+$/, "");

/** Resolve a route template against the base url, substituting the id param. */
const urlFor = (baseUrl: string, path: string, id?: string): string =>
  trimSlashes(baseUrl) + path.replace(/:[^/]+/g, () => encodeURIComponent(id ?? ""));

/** A content-hash row version: a plain REST API exposes no version token. */
export const versionOf = Hash.contentHash;

const backendError = (message: string) => (cause: unknown) => new BackendError({ message, cause });

/** Append `?`/`&`-joined params to an existing query string. */
const appendQuery = (query: string, extra: string): string =>
  extra === "" ? query : query === "" ? `?${extra}` : `${query}&${extra}`;

/**
 * The set of ids a subset pins via an `id IN (...)` / `id = ...` filter, or
 * `undefined` if it isn't id-pinned. Used to recognize auto-subscribed
 * relationship subsets that the include fast-path can serve from cache.
 */
const pinnedIds = (predicate: Predicate.Predicate): ReadonlySet<string> | undefined => {
  switch (predicate._tag) {
    case "In":
      return predicate.field === "id"
        ? new Set(predicate.values.map((value) => String(value)))
        : undefined;
    case "Compare":
      return predicate.op === "eq" && predicate.field === "id"
        ? new Set([String(predicate.value)])
        : undefined;
    case "And": {
      for (const inner of predicate.predicates) {
        const ids = pinnedIds(inner);
        if (ids !== undefined) return ids;
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

/** What an applied write leaves in its row: the value it wrote, or a delete. */
type WriteEffect = { readonly _tag: "put"; readonly value: unknown } | { readonly _tag: "delete" };

/**
 * Fold one applied write's effect into a push's PUT values (mutates `puts`). A
 * put records the row's value. A delete drops an earlier write's value for the
 * row, so a later delete in the same push leaves the hint naming it as a
 * delete (#369).
 */
const recordEffect = (
  puts: Map<string, Map<string, unknown>>,
  collection: string,
  id: string,
  effect: WriteEffect
): void => {
  if (effect._tag === "delete") {
    puts.get(collection)?.delete(id);
  } else {
    puts.set(
      collection,
      (puts.get(collection) ?? new Map<string, unknown>()).set(id, effect.value)
    );
  }
};

/** Record a touched id under its collection (mutates `touched`). */
const recordTouched = (touched: Map<string, Set<string>>, collection: string, id: string): void => {
  touched.set(collection, (touched.get(collection) ?? new Set<string>()).add(id));
};

/** What one push knows about a row it writes (ADR-0023's `oldValues`). */
interface RowEntry {
  /** The row's value before the push's first write to it: none when absent, or when the push created it. */
  readonly before: Option.Option<JsonApiRow>;
  /** The row's value after the writes applied so far: none once deleted, or when unknown. */
  current: Option.Option<JsonApiRow>;
}

/** The mutable accumulators one push folds its per-mutation outcomes into. */
interface WriteAccumulator {
  readonly touched: Map<string, Set<string>>;
  readonly puts: Map<string, Map<string, unknown>>;
  readonly rejected: Array<Backend.RejectedMutation>;
  /** The rows this push has read or applied a write to, by collection, then id. */
  readonly rows: Map<string, Map<string, RowEntry>>;
}

/** The row entry for (collection, id), if this push has entered the row. */
const entryOf = (acc: WriteAccumulator, collection: string, id: string): RowEntry | undefined =>
  acc.rows.get(collection)?.get(id);

/** Enter a row under (collection, id) (mutates `acc`). */
const setEntry = (acc: WriteAccumulator, collection: string, id: string, entry: RowEntry): void => {
  acc.rows.set(
    collection,
    (acc.rows.get(collection) ?? new Map<string, RowEntry>()).set(id, entry)
  );
};

/**
 * The pre-push values this push read, as the hints' `olds`: the same snapshot
 * MemoryBackend takes before it applies a batch.
 */
const oldsOf = (acc: WriteAccumulator): Map<string, Map<string, unknown>> => {
  const olds = new Map<string, Map<string, unknown>>();
  for (const [collection, entries] of acc.rows) {
    for (const [id, entry] of entries) {
      if (Option.isSome(entry.before)) {
        olds.set(
          collection,
          (olds.get(collection) ?? new Map<string, unknown>()).set(id, entry.before.value)
        );
      }
    }
  }
  return olds;
};

/**
 * Fold one applied write into the push: the row's value after it, and the
 * write's effect on the hint. A row the push has not entered was absent before
 * the push wrote it (a create), so it starts with no value.
 */
const recordApplied = (
  acc: WriteAccumulator,
  write: Write,
  document: JsonApiRow | undefined
): void => {
  const entry = entryOf(acc, write.type, write.id) ?? {
    before: Option.none<JsonApiRow>(),
    current: Option.none<JsonApiRow>(),
  };
  setEntry(acc, write.type, write.id, entry);
  entry.current =
    write.operation === "delete"
      ? Option.none<JsonApiRow>()
      : Option.some(rowAfter(write, entry.current, document));
  recordTouched(acc.touched, write.type, write.id);
  recordEffect(
    acc.puts,
    write.type,
    write.id,
    Option.isSome(entry.current) ? { _tag: "put", value: entry.current.value } : { _tag: "delete" }
  );
};

/** Build a JSON:API write body (`{ data: { type, id, attributes, ... } }`). */
const writeBody = (
  type: string,
  id: string,
  attributes: Record<string, unknown>,
  relationships?: Record<string, unknown>
): { readonly data: Record<string, unknown> } => ({
  data: {
    type,
    id,
    attributes,
    ...(relationships !== undefined ? { relationships } : {}),
  },
});

/** A write's relationships in the row's linkage shape, as `toRow` gives a server document. */
const linkageOf = (write: Write): Record<string, RelationshipRef> =>
  resourceToRow({
    type: write.type,
    id: write.id,
    relationships: write.relationships ?? {},
  } as ResourceObject).value.relationships;

/**
 * The value a create/update writes, as the hint carries it — the same shape
 * `toRow` gives a resource the server returned, so a hint looks alike
 * whichever path produced it and whatever the server answered.
 */
const writtenValue = (write: Write): JsonApiRow => ({
  ...write.attributes,
  id: write.id,
  relationships: linkageOf(write),
});

/** The row after a partial update: the row read before the push, with the write laid over it. */
const mergeWrite = (read: JsonApiRow, write: Write): JsonApiRow => ({
  ...read,
  ...write.attributes,
  id: write.id,
  relationships: { ...read.relationships, ...linkageOf(write) },
});

/**
 * The value a create or update leaves its row with: the server's document when
 * it returned one; otherwise the row's value so far merged with the write; or
 * the written value alone when the push does not know the row.
 */
const rowAfter = (
  write: Write,
  current: Option.Option<JsonApiRow>,
  document: JsonApiRow | undefined
): JsonApiRow =>
  document ?? (Option.isSome(current) ? mergeWrite(current.value, write) : writtenValue(write));

/** Express a derived CRUD mutator's decoded args as one JSON:API write. */
const writeOf = (operation: OperationInfo, args: unknown): Effect.Effect<Write, BackendError> => {
  switch (operation.operation) {
    case "create": {
      const a = args as {
        id: string;
        attributes: Record<string, unknown>;
        relationships?: Record<string, unknown>;
      };
      return Effect.succeed({
        operation: "create",
        type: operation.type,
        id: a.id,
        attributes: a.attributes,
        ...(a.relationships !== undefined ? { relationships: a.relationships } : {}),
      });
    }
    case "update": {
      const a = args as { id: string; attributes: Record<string, unknown> };
      return Effect.succeed({
        operation: "update",
        type: operation.type,
        id: a.id,
        attributes: a.attributes,
      });
    }
    case "delete": {
      const a = args as { id: string };
      return Effect.succeed({ operation: "delete", type: operation.type, id: a.id });
    }
    default:
      return Effect.fail(
        new BackendError({ message: `Operation "${operation.operation}" is not a write` })
      );
  }
};

/** One write as an atomic operation object (`add` / `update` / `remove`). */
const operationOf = (write: Write): Record<string, unknown> => {
  switch (write.operation) {
    case "create":
      return {
        op: "add",
        data: {
          type: write.type,
          id: write.id,
          attributes: write.attributes ?? {},
          ...(write.relationships !== undefined ? { relationships: write.relationships } : {}),
        },
      };
    case "update":
      return {
        op: "update",
        data: {
          type: write.type,
          id: write.id,
          attributes: write.attributes ?? {},
          ...(write.relationships !== undefined ? { relationships: write.relationships } : {}),
        },
      };
    case "delete":
      return { op: "remove", ref: { type: write.type, id: write.id } };
  }
};

/**
 * The index of the operation an error's `source.pointer` names — the
 * operation itself (`Atomic.operationPointer(i)`) or a member below it — or
 * `undefined` when the pointer names none of the `count` operations sent.
 */
const operationIndex = (pointer: string, count: number): number | undefined => {
  const match = /^\/atomic:operations\/(\d+)(?:\/|$)/.exec(pointer);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return index < count && Atomic.operationPointer(index) === `/atomic:operations/${index}`
    ? index
    : undefined;
};

/** The per-operation rejections an error document carries, by operation index. */
const rejectionsOf = (
  body: unknown,
  count: number,
  fallbackReason: string
): ReadonlyArray<{ readonly index: number; readonly reason: string }> => {
  const errors =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { errors?: unknown }).errors)
      ? ((body as { errors: ReadonlyArray<unknown> }).errors as ReadonlyArray<{
          readonly title?: string;
          readonly detail?: string;
          readonly source?: { readonly pointer?: string };
        }>)
      : [];
  const byIndex = new Map<number, string>();
  for (const error of errors) {
    const pointer = error?.source?.pointer;
    if (typeof pointer !== "string") continue;
    const index = operationIndex(pointer, count);
    if (index === undefined || byIndex.has(index)) continue;
    byIndex.set(index, error.detail ?? error.title ?? fallbackReason);
  }
  return [...byIndex].map(([index, reason]) => ({ index, reason }));
};

/** A write of one push's batch, with its position in the batch. */
interface BatchEntry {
  readonly index: number;
  readonly write: Write;
}

/** The row an `atomic:results` entry carries, if it returned a resource. */
const resultRow = (result: unknown): JsonApiRow | undefined => {
  const data =
    typeof result === "object" && result !== null ? (result as { data?: unknown }).data : undefined;
  const resource = Schema.decodeUnknownOption(ResourceObjectSchema)(data);
  return Option.isSome(resource) ? toRow(resourceToRow(resource.value).value) : undefined;
};

/** One atomic request's outcome: everything applied, or some operations named as rejected. */
type AtomicOutcome =
  | { readonly _tag: "applied"; readonly results: ReadonlyArray<unknown> }
  | {
      readonly _tag: "rejected";
      readonly rejections: ReadonlyArray<{ readonly index: number; readonly reason: string }>;
    };

/**
 * Enter a row an atomic batch creates, before the batch's one request. The row
 * was absent before the push, so it needs no read: a later update or delete of
 * it in the same batch must not GET it, since that 404 would fail the push. An
 * entry already present (an earlier delete in the batch read the row) is kept.
 * A create the server refuses is the one case where the row may exist; the
 * resend reads it then (`readRefusedCreates`).
 */
const enterBatchCreate = (acc: WriteAccumulator, write: Write): void => {
  if (entryOf(acc, write.type, write.id) === undefined)
    setEntry(acc, write.type, write.id, { before: Option.none(), current: Option.none() });
};

/** Build the JsonApiBackend from its config; requires an `HttpClient`. */
export const make = (
  config: JsonApiBackendConfig
): Effect.Effect<Backend.Backend, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const encoder = config.query ?? defaultEncoder;
    const includes = config.includes ?? {};
    // collection → id → most-recently-listed row (warms getRows).
    const cache = yield* Ref.make(new Map<string, Map<string, JsonApiRow>>());
    // collection → ids known complete in cache via a compound `included` harvest.
    const includedIds = yield* Ref.make(new Map<string, Set<string>>());
    // clientGroupId → clientId → highest applied mutation id (in-session).
    const ledger = yield* Ref.make(new Map<string, Map<string, number>>());

    const getJson = (url: string) =>
      Effect.scoped(
        client.execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(jsonApiHeaders))
        )
      );

    // A transport-level failure (connection lost) or a 5xx is transient — a
    // BackendError that aborts the push. A 4xx is a permanent rejection (bad
    // request, forbidden, conflict): the server did not apply the write, so it
    // is a MutationRejected that skips the mutation without poisoning the queue.
    // 408/429 are the transient exceptions in the 4xx band (timeout, rate limit).
    const transientStatuses = new Set([408, 429]);
    const isPermanentStatus = (status: number): boolean =>
      status >= 400 && status < 500 && !transientStatuses.has(status);
    /** Send one write; the resource document it answers with, if it answers with one. */
    const sendWrite = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.scoped(client.execute(request)).pipe(
        Effect.mapError(backendError("JSON:API write failed")),
        Effect.flatMap(
          (response): Effect.Effect<JsonApiRow | undefined, BackendError | MutationRejected> => {
            if (response.status >= 200 && response.status < 300)
              return response.json.pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.map(resultRow)
              );
            const message = `JSON:API write returned HTTP ${response.status}`;
            return isPermanentStatus(response.status)
              ? Effect.fail(new MutationRejected({ reason: message }))
              : Effect.fail(new BackendError({ message }));
          }
        )
      );

    /**
     * The `getOne` route an update or delete reads its row through. A resource
     * with no such route cannot be written by update or delete, so the write
     * fails with BackendError before anything is sent.
     */
    const getOneFor = (type: string): Effect.Effect<{ readonly path: string }, BackendError> => {
      const getOne = config.resources.get(type)?.getOne;
      return getOne === undefined
        ? Effect.fail(
            new BackendError({
              message: `"${type}" has no getOne route, so its updates and deletes cannot read the row before writing it`,
            })
          )
        : Effect.succeed(getOne);
    };

    /**
     * Read a row before the push writes it: the value the server holds now. Every
     * failed read fails the push with BackendError, a 404 and any other 4xx
     * included, and so does a 2xx whose document carries no resource: an update
     * or delete that went out without its old value would hint no `oldValues`, so
     * it is not sent instead. On the atomic path every read precedes the one
     * request, so nothing is written on a read the push cannot complete. On the
     * per-resource path the writes before the failed read have already applied,
     * and their hints are lost (see the module header's delivery note).
     *
     * A cache-hit path would plug in here, returning the cached row without the
     * GET, once the cache has a freshness signal (a version token, or
     * invalidation by this backend's own writes). Until then the cache is never
     * consulted for an old value; see #395.
     */
    const readBefore = (type: string, id: string): Effect.Effect<JsonApiRow, BackendError> =>
      Effect.gen(function* () {
        const getOne = yield* getOneFor(type);
        const response = yield* getJson(urlFor(config.baseUrl, getOne.path, id)).pipe(
          Effect.mapError(backendError(`Failed to read ${type}/${id} before writing it`))
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new BackendError({
            message: `JSON:API read of ${type}/${id} returned HTTP ${response.status}`,
          });
        const document = yield* parseResponse(response).pipe(
          Effect.mapError(backendError(`Invalid JSON:API resource ${type}/${id}`))
        );
        const resource = documentToRows(document).rows[0]?.value;
        if (resource === undefined)
          return yield* new BackendError({
            message: `JSON:API read of ${type}/${id} returned no resource`,
          });
        return toRow(resource);
      });

    /**
     * Enter a row the write touches. An update or delete reads the row on the
     * push's first write to it, so the pre-push value is kept for the hint (the
     * read is `readBefore`, where a cache hit would replace it, #395). A row
     * already entered is not read again. A create reads nothing and enters no
     * row: its row is entered when the create applies, or up front for the
     * atomic path's batch (`enterBatchCreate`).
     */
    const enterRow = (acc: WriteAccumulator, write: Write): Effect.Effect<void, BackendError> => {
      if (write.operation === "create" || entryOf(acc, write.type, write.id) !== undefined)
        return Effect.void;
      return readBefore(write.type, write.id).pipe(
        Effect.map((before) =>
          setEntry(acc, write.type, write.id, {
            before: Option.some(before),
            current: Option.some(before),
          })
        )
      );
    };

    /**
     * Refuse a write that cannot be read before it is sent: an update or delete
     * of a resource with no `getOne` route. Checked for a whole push before its
     * first write, so a push that cannot be read sends nothing on either path.
     */
    const checkReadable = (write: Write): Effect.Effect<void, BackendError> =>
      write.operation === "create" ? Effect.void : getOneFor(write.type).pipe(Effect.asVoid);

    /** Enter one write of an atomic batch before its request: a create as absent, others by reading the row. */
    const enterBatchWrite = (
      acc: WriteAccumulator,
      write: Write
    ): Effect.Effect<void, BackendError> =>
      write.operation === "create"
        ? Effect.sync(() => enterBatchCreate(acc, write))
        : enterRow(acc, write);

    /**
     * Read the rows the batch's refused creates would have made absent (#402).
     * The batch entered each row a create touches as absent, which is right only
     * while the create applies. The server refused these creates, so the row may
     * exist: when a later update or delete of it is still to be sent, read it
     * now, before the resend, so that write carries its pre-push value. Each row
     * is read at most once, and a row no remaining update or delete touches is
     * not read, so a create that applies never makes a read that can fail the push.
     */
    const readRefusedCreates = (
      acc: WriteAccumulator,
      refused: ReadonlyArray<BatchEntry>,
      remaining: ReadonlyArray<BatchEntry>
    ): Effect.Effect<void, BackendError> =>
      Effect.forEach(
        refused.filter((entry) => entry.write.operation === "create"),
        (create) => {
          const { type, id } = create.write;
          const laterWrite = remaining.some(
            (entry) =>
              entry.index > create.index &&
              entry.write.operation !== "create" &&
              entry.write.type === type &&
              entry.write.id === id
          );
          const entry = entryOf(acc, type, id);
          if (!laterWrite || (entry !== undefined && Option.isSome(entry.before)))
            return Effect.void;
          return readBefore(type, id).pipe(
            Effect.map((row) =>
              setEntry(acc, type, id, { before: Option.some(row), current: Option.some(row) })
            )
          );
        },
        { discard: true }
      );

    const cacheRows = (collection: string, rows: ReadonlyArray<JsonApiRow>) =>
      Ref.update(cache, (current) => {
        const next = new Map(current);
        const map = new Map(next.get(collection) ?? []);
        for (const value of rows) map.set(value.id, value);
        next.set(collection, map);
        return next;
      });

    /** Harvest a compound document's `included` rows; record their ids complete. */
    const harvestIncluded = (
      included: ReadonlyArray<JsonApiRow & { readonly $collection: string }>
    ) =>
      Effect.gen(function* () {
        const byCollection = new Map<string, Array<JsonApiRow>>();
        for (const row of included) {
          const rows = byCollection.get(row.$collection) ?? [];
          rows.push(row);
          byCollection.set(row.$collection, rows);
        }
        for (const [collection, rows] of byCollection) {
          yield* cacheRows(collection, rows);
          yield* Ref.update(includedIds, (current) => {
            const next = new Map(current);
            const ids = new Set(next.get(collection) ?? []);
            for (const row of rows) ids.add(row.id);
            next.set(collection, ids);
            return next;
          });
        }
      });

    const entriesFrom = (values: ReadonlyArray<JsonApiRow>, subset: Subset.Subset) =>
      Subset.apply(
        values.map((value) => ({ id: value.id, value })),
        subset
      ).map((row) => ({ id: row.id, version: versionOf(row.value) }));

    const evaluate: Backend.Backend["evaluate"] = (_context, subset) =>
      Effect.gen(function* () {
        const list = config.resources.get(subset.collection)?.list;
        if (list === undefined) return [];
        // Correlated Exists is a relational join this REST backend can't resolve;
        // fail closed rather than silently skip the filter (denormalize, or use a
        // backend that resolves Exists).
        if (Predicate.hasExists(subset.where)) {
          return yield* new BackendError({
            message: `JSON:API backend does not support Exists predicates on "${subset.collection}"`,
          });
        }

        // Include fast-path: an auto-subscribed `id IN (...)` subset whose ids
        // were all delivered by a prior compound `included` harvest is served
        // from cache — the related rows arrived with their parent, no round trip.
        const ids = pinnedIds(subset.where);
        if (ids !== undefined) {
          const complete = (yield* Ref.get(includedIds)).get(subset.collection);
          if (complete !== undefined && [...ids].every((id) => complete.has(id))) {
            const cached = (yield* Ref.get(cache)).get(subset.collection);
            if (cached !== undefined && [...ids].every((id) => cached.has(id))) {
              return entriesFrom([...cached.values()], subset);
            }
          }
        }

        // The exact filter goes to the server; a predicate no row can match
        // (an empty allow-set) is answered here without a request. A
        // predicate with no URL form fails closed.
        const encoded = yield* encoder
          .encode(subset)
          .pipe(Effect.mapError(backendError(`Subset on "${subset.collection}" has no URL form`)));
        if (Option.isNone(encoded)) return [];
        const includeParam = (includes[subset.collection] ?? []).join(",");
        const query = appendQuery(
          encoded.value,
          includeParam === "" ? "" : `include=${encodeURIComponent(includeParam)}`
        );
        const url = urlFor(config.baseUrl, list.path) + query;
        const response = yield* getJson(url).pipe(
          Effect.mapError(backendError(`Failed to list "${subset.collection}"`))
        );
        const document = yield* parseResponse(response).pipe(
          Effect.mapError(backendError(`Invalid JSON:API listing "${subset.collection}"`))
        );
        const loaded = documentToRows(document);
        const values = loaded.rows.map((row) => toRow(row.value));
        yield* cacheRows(subset.collection, values);
        yield* harvestIncluded(
          loaded.included.map((row) => ({ ...toRow(row.value), $collection: row.collection }))
        );
        return entriesFrom(values, subset);
      });

    const getRows: Backend.Backend["getRows"] = (_context, collection, ids) =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(cache)).get(collection);
        const getOne = config.resources.get(collection)?.getOne;
        const result: Array<{ id: string; version: string; value: unknown }> = [];
        for (const id of ids) {
          const hit = cached?.get(id);
          if (hit !== undefined) {
            result.push({ id, version: versionOf(hit), value: hit });
            continue;
          }
          if (getOne === undefined) continue;
          const response = yield* getJson(urlFor(config.baseUrl, getOne.path, id)).pipe(
            Effect.mapError(backendError(`Failed to fetch ${collection}/${id}`))
          );
          // A 404 is an absent row: omitted, as the contract requires.
          if (response.status === 404) continue;
          const document = yield* parseResponse(response).pipe(
            Effect.mapError(backendError(`Invalid JSON:API resource ${collection}/${id}`))
          );
          const resource = documentToRows(document).rows[0]?.value;
          if (resource !== undefined) {
            const value = toRow(resource);
            result.push({ id, version: versionOf(value), value });
          }
        }
        return result;
      });

    /** Decode a pushed mutation's args and express it as one JSON:API write. */
    const writeFor = (mutation: PushedMutation): Effect.Effect<Write, BackendError> =>
      Effect.gen(function* () {
        const definition = config.mutators.get(mutation.mutator);
        const custom = config.writes?.get(mutation.mutator);
        const operation = config.operations.get(mutation.mutator);
        if (definition === undefined || (custom === undefined && operation === undefined))
          return yield* UnknownMutator.make(mutation.mutator);
        const args = yield* Schema.decodeUnknownEffect(definition.args)(mutation.args).pipe(
          Effect.mapError(backendError(`Invalid args for mutator "${mutation.mutator}"`))
        );
        return custom !== undefined ? custom(args) : yield* writeOf(operation!, args);
      });

    // Apply one write as its own request. Resolves to the resource document the
    // server answered a create or update with, if it sent one.
    const applyOne = (
      write: Write
    ): Effect.Effect<JsonApiRow | undefined, BackendError | MutationRejected> =>
      Effect.gen(function* () {
        const resource = config.resources.get(write.type);
        switch (write.operation) {
          case "create": {
            const ref = resource?.create;
            if (ref === undefined)
              return yield* new BackendError({ message: `No create endpoint for "${write.type}"` });
            return yield* sendWrite(
              HttpClientRequest.post(urlFor(config.baseUrl, ref.path)).pipe(
                HttpClientRequest.setHeaders(jsonApiHeaders),
                HttpClientRequest.bodyJsonUnsafe(
                  writeBody(write.type, write.id, write.attributes ?? {}, write.relationships)
                )
              )
            );
          }
          case "update": {
            const ref = resource?.update;
            if (ref === undefined)
              return yield* new BackendError({ message: `No update endpoint for "${write.type}"` });
            return yield* sendWrite(
              HttpClientRequest.patch(urlFor(config.baseUrl, ref.path, write.id)).pipe(
                HttpClientRequest.setHeaders(jsonApiHeaders),
                HttpClientRequest.bodyJsonUnsafe(
                  writeBody(write.type, write.id, write.attributes ?? {}, write.relationships)
                )
              )
            );
          }
          case "delete": {
            const ref = resource?.delete;
            if (ref === undefined)
              return yield* new BackendError({ message: `No delete endpoint for "${write.type}"` });
            yield* sendWrite(
              HttpClientRequest.make("DELETE")(urlFor(config.baseUrl, ref.path, write.id)).pipe(
                HttpClientRequest.setHeaders(jsonApiHeaders)
              )
            );
            return undefined;
          }
        }
      });

    /** Acknowledge mutations in the in-session ledger, in the order given, in one update. */
    const bumpLedger = (
      context: Backend.SyncContext,
      mutations: ReadonlyArray<{ readonly clientId: string; readonly mutationId: number }>
    ) =>
      Ref.update(ledger, (current) => {
        const next = new Map(current);
        const groupIds = new Map(next.get(context.clientGroupId) ?? []);
        for (const mutation of mutations) groupIds.set(mutation.clientId, mutation.mutationId);
        next.set(context.clientGroupId, groupIds);
        return next;
      });

    const lastMutationIdsOf = (context: Backend.SyncContext) =>
      Ref.get(ledger).pipe(
        Effect.map((current) => Object.fromEntries(current.get(context.clientGroupId) ?? new Map()))
      );

    /**
     * The mutations a push still has to send, in order, each with its write. A
     * mutation at or below its client's acknowledged id was already applied, so it
     * is skipped (idempotent, in-session). With `strict`, a mutation past the next
     * expected id is a gap the push cannot apply, so the push is refused.
     */
    const unacknowledged = (
      context: Backend.SyncContext,
      mutations: ReadonlyArray<PushedMutation>,
      strict: boolean
    ): Effect.Effect<
      Array<{ readonly mutation: PushedMutation; readonly write: Write }>,
      BackendError
    > =>
      Effect.gen(function* () {
        const group = (yield* Ref.get(ledger)).get(context.clientGroupId) ?? new Map();
        const expected = new Map<string, number>(group);
        const batch: Array<{ readonly mutation: PushedMutation; readonly write: Write }> = [];
        for (const mutation of mutations) {
          const last = expected.get(mutation.clientId) ?? 0;
          if (mutation.mutationId <= last) continue; // idempotent (in-session)
          if (strict && mutation.mutationId > last + 1)
            return yield* new BackendError({
              message: `Mutation-id gap for client "${mutation.clientId}": expected ${last + 1}, got ${mutation.mutationId}`,
            });
          expected.set(mutation.clientId, mutation.mutationId);
          batch.push({ mutation, write: yield* writeFor(mutation) });
        }
        return batch;
      });

    /**
     * The mutations a per-resource push still has to send, in order. A mutation
     * at or below its client's acknowledged id was already applied, so it is
     * skipped (idempotent, in-session). Unlike `unacknowledged`, nothing is
     * decoded and no gap is refused here: the send loop does both, in order.
     */
    const pendingEach = (
      context: Backend.SyncContext,
      mutations: ReadonlyArray<PushedMutation>
    ): Effect.Effect<ReadonlyArray<PushedMutation>> =>
      Effect.gen(function* () {
        const expected = new Map<string, number>(
          (yield* Ref.get(ledger)).get(context.clientGroupId) ?? []
        );
        const pending: Array<PushedMutation> = [];
        for (const mutation of mutations) {
          const last = expected.get(mutation.clientId) ?? 0;
          if (mutation.mutationId <= last) continue; // idempotent (in-session)
          expected.set(mutation.clientId, mutation.mutationId);
          pending.push(mutation);
        }
        return pending;
      });

    /**
     * Replay each write as its own request (at-least-once, in order). Before the
     * first request, each pending mutation that decodes is checked for a `getOne`
     * route, so a write that cannot be read sends nothing. A mutation whose args
     * do not decode is not checked: the loop fails the push at it, after the
     * writes before it, as it always has.
     */
    const applyEach = (
      context: Backend.SyncContext,
      mutations: ReadonlyArray<PushedMutation>
    ): Effect.Effect<Backend.ApplyResult, BackendError> =>
      Effect.gen(function* () {
        const acc: WriteAccumulator = {
          touched: new Map(),
          puts: new Map(),
          rejected: [],
          rows: new Map(),
        };
        const pending = yield* pendingEach(context, mutations);
        const decoded = yield* Effect.forEach(pending, (mutation) =>
          Effect.gen(function* () {
            const write = yield* writeFor(mutation).pipe(Effect.option);
            if (Option.isSome(write)) yield* checkReadable(write.value);
            return { mutation, write };
          })
        );

        for (const { mutation, write: decodedWrite } of decoded) {
          // An undecodable mutation decodes again here and fails the push with the
          // same BackendError it always raised, leaving its ledger entry unmoved.
          const write = Option.isSome(decodedWrite)
            ? decodedWrite.value
            : yield* writeFor(mutation);
          yield* enterRow(acc, write);
          // A permanent HTTP rejection (4xx) skips this mutation but still bumps
          // its id, so it is acknowledged and never poisons the queue. A
          // transient failure propagates and aborts the push.
          const outcome = yield* applyOne(write).pipe(
            Effect.map((document) => ({ _tag: "applied", document }) as const),
            Effect.catchTag("MutationRejected", (error) =>
              Effect.succeed({ _tag: "rejected", reason: error.reason } as const)
            )
          );
          if (outcome._tag === "applied") recordApplied(acc, write, outcome.document);
          else
            acc.rejected.push({
              clientId: mutation.clientId,
              mutationId: mutation.mutationId,
              reason: outcome.reason,
            });
          yield* bumpLedger(context, [mutation]);
        }

        return {
          lastMutationIds: yield* lastMutationIdsOf(context),
          hints: Backend.buildChangeHints(acc.touched, acc.puts, oldsOf(acc)),
          ...(acc.rejected.length > 0 ? { rejected: acc.rejected } : {}),
        };
      });

    /** Send one `atomic:operations` request and classify the server's answer. */
    const sendAtomic = (
      path: string,
      operations: ReadonlyArray<Record<string, unknown>>
    ): Effect.Effect<AtomicOutcome, BackendError> =>
      Effect.gen(function* () {
        const response = yield* Effect.scoped(
          client.execute(
            HttpClientRequest.post(urlFor(config.baseUrl, path)).pipe(
              HttpClientRequest.bodyText(
                JSON.stringify({ "atomic:operations": operations }),
                Atomic.MEDIA_TYPE
              ),
              HttpClientRequest.setHeaders(atomicHeaders)
            )
          )
        ).pipe(Effect.mapError(backendError("JSON:API atomic:operations request failed")));
        const status = response.status;
        const message = `JSON:API atomic:operations returned HTTP ${status}`;
        // A 204 (or an unparseable success body) still means every operation applied.
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
        if (status >= 200 && status < 300) {
          const results =
            typeof body === "object" && body !== null
              ? (body as { readonly "atomic:results"?: unknown })["atomic:results"]
              : undefined;
          return { _tag: "applied", results: Array.isArray(results) ? results : [] } as const;
        }
        if (isPermanentStatus(status)) {
          const rejections = rejectionsOf(body, operations.length, message);
          if (rejections.length > 0) return { _tag: "rejected", rejections } as const;
        }
        // 5xx, 408/429, transport, or a 4xx naming no operation: transient.
        return yield* new BackendError({ message });
      });

    /**
     * Push the batch as one `atomic:operations` request. Nothing is
     * acknowledged until the server has applied the whole (remaining) batch;
     * permanently rejected operations are dropped and the rest resent.
     */
    const applyAtomic = (
      context: Backend.SyncContext,
      mutations: ReadonlyArray<PushedMutation>,
      atomic: { readonly path: string }
    ): Effect.Effect<Backend.ApplyResult, BackendError> =>
      Effect.gen(function* () {
        const batch = yield* unacknowledged(context, mutations, true);

        // Read the rows the batch updates or deletes before the one request that
        // writes them, so a failed read sends nothing. A row the batch creates is
        // not read (see enterBatchCreate).
        const acc: WriteAccumulator = {
          touched: new Map(),
          puts: new Map(),
          rejected: [],
          rows: new Map(),
        };
        for (const { write } of batch) yield* enterBatchWrite(acc, write);

        // Batch index → rejection reason; each round trip drops at least one.
        const rejectedAt = new Map<number, string>();
        let pending = batch.map((entry, index) => ({ ...entry, index }));
        let results: ReadonlyArray<unknown> = [];
        while (pending.length > 0) {
          const outcome = yield* sendAtomic(
            atomic.path,
            pending.map((entry) => operationOf(entry.write))
          );
          if (outcome._tag === "applied") {
            results = outcome.results;
            break;
          }
          const refused = outcome.rejections.map(({ index }) => pending[index]!);
          for (const { index, reason } of outcome.rejections) {
            rejectedAt.set(pending[index]!.index, reason);
          }
          pending = pending.filter((entry) => !rejectedAt.has(entry.index));
          // A create the server refused may have left its row in place: read it
          // before the resend when a later write of it still needs the old value.
          yield* readRefusedCreates(acc, refused, pending);
        }

        // Hints from what applied, in push order: each row's value from the
        // result document where the server returned one, else as merged or
        // written. A delete drops an earlier write's value for the row (#369).
        pending.forEach(({ write }, position) =>
          recordApplied(acc, write, resultRow(results[position]))
        );

        // Applied and rejected alike are acknowledged, in original order.
        yield* bumpLedger(
          context,
          batch.map(({ mutation }) => mutation)
        );
        const rejected = [...rejectedAt]
          .toSorted(([a], [b]) => a - b)
          .map(([index, reason]) => ({
            clientId: batch[index]!.mutation.clientId,
            mutationId: batch[index]!.mutation.mutationId,
            reason,
          }));

        return {
          lastMutationIds: yield* lastMutationIdsOf(context),
          hints: Backend.buildChangeHints(acc.touched, acc.puts, oldsOf(acc)),
          ...(rejected.length > 0 ? { rejected } : {}),
        };
      });

    const applyMutations: Backend.Backend["applyMutations"] = (context, mutations) =>
      config.atomic === undefined
        ? applyEach(context, mutations)
        : applyAtomic(context, mutations, config.atomic);

    return Backend.Backend.of({
      applyMutations,
      lastMutationIds: lastMutationIdsOf,
      evaluate,
      getRows,
    });
  });
