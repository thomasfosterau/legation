/**
 * HostRequest
 *
 * The mirror protocol's one generic request/response envelope (ADR-0021
 * amendment, #146, #136): a mirror asks its engine host for something outside
 * the `ClientView` surface by naming a **request kind**, and the host answers
 * from the handler it registered for that kind.
 *
 * A kind is declared once, as a value: its name, a request schema, a response
 * schema, and whether it streams ({@link single}, {@link streaming}). Both
 * sides encode and decode through the kind's schemas, so the payload is typed
 * at each end and `unknown` only on the wire. The host keeps a registry of the
 * kinds it serves ({@link handler}, {@link streamHandler}, passed to
 * `EngineHost.run`'s `requests`); a mirror asks through `Mirror.request` (a
 * single-reply kind) or `Mirror.stream` (a streaming kind).
 *
 * Core's kinds carry bare names (`introspect/journal`); a kind declared
 * outside core is prefixed with its package
 * (`@thomasfosterau/legation-devtools/forcePush`), so no two packages claim
 * one name.
 *
 * Every failure is a reply ({@link HostRequestError}): a kind the host does
 * not serve is `UnknownKind`, a payload that does not decode is
 * `InvalidRequest`, a handler that fails or dies is `Failed`, and a request
 * no host answered in time (a host that predates the envelope, or one that
 * restarted while it was in flight) is `Unanswered`.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as MirrorProtocol from "./MirrorProtocol.js";

/**
 * A request kind: the name a `HostRequest` carries, the schemas its request
 * and response are encoded with, and whether the host answers it with one
 * value or a stream of them.
 */
export interface Kind<I, O, S extends boolean = boolean> {
  /** The kind's wire name; prefixed with the declaring package outside core. */
  readonly name: string;
  /** The request's codec: the mirror encodes with it, the host decodes. */
  readonly request: Schema.Codec<I, unknown>;
  /** The response's codec: the host encodes each value with it, the mirror decodes. */
  readonly response: Schema.Codec<O, unknown>;
  /** Whether the host answers with a stream of `Item`s and an `End` rather than one `Value`. */
  readonly streaming: S;
}

/** A kind the host answers with exactly one value. */
export type Single<I, O> = Kind<I, O, false>;

/** A kind the host answers with a stream of values, ended by the host or cancelled by the mirror. */
export type Streaming<I, O> = Kind<I, O, true>;

/** The schemas a kind is declared with. */
export interface KindSchemas<I, O> {
  readonly request: Schema.Codec<I, unknown>;
  readonly response: Schema.Codec<O, unknown>;
}

/** Declare a single-reply request kind. */
export const single = <I, O>(name: string, schemas: KindSchemas<I, O>): Single<I, O> => ({
  name,
  request: schemas.request,
  response: schemas.response,
  streaming: false,
});

/** Declare a streaming request kind. */
export const streaming = <I, O>(name: string, schemas: KindSchemas<I, O>): Streaming<I, O> => ({
  name,
  request: schemas.request,
  response: schemas.response,
  streaming: true,
});

/** The request schema of a kind that takes no input: an empty object on the wire. */
export const NoInput = Schema.Struct({});

/** The type {@link NoInput} decodes to. */
export type NoInput = typeof NoInput.Type;

/** The response schema of a kind that answers only "done": an empty object on the wire. */
export const Done = Schema.Struct({});

/** The type {@link Done} decodes to. */
export type Done = typeof Done.Type;

/**
 * Why a host request failed, as the mirror reports it: the host's three
 * failure replies (`MirrorProtocol.HostFailureReason`), or `Unanswered` when
 * no reply arrived — the host predates the envelope, restarted while the
 * request was in flight, or this mirror closed.
 */
export type HostRequestFailure = MirrorProtocol.HostFailureReason | "Unanswered";

/** A host request that failed: the kind it named, why, and the host's or mirror's message. */
export class HostRequestError extends Schema.TaggedError<
  HostRequestError,
  { readonly brand: unique symbol }
>()("HostRequestError", {
  kind: Schema.String,
  reason: Schema.Literals(["UnknownKind", "InvalidRequest", "Failed", "Unanswered"]),
  message: Schema.String,
}) {}

/** What a mirror needs to ask a host: the two request verbs `Mirror` implements. */
export interface Requester {
  /** Ask the host a single-reply kind and wait for its answer (with the mirror's timeout). */
  readonly request: <I, O>(kind: Single<I, O>, input: I) => Effect.Effect<O, HostRequestError>;
  /**
   * Follow a streaming kind's answer. The request lives as long as the
   * stream: a consumer that stops early, or is interrupted, cancels it on the
   * host.
   */
  readonly stream: <I, O>(kind: Streaming<I, O>, input: I) => Stream.Stream<O, HostRequestError>;
}

/**
 * A host-side handler: the kind it serves and how one request's encoded
 * payload becomes the outcomes the host posts back. Built with
 * {@link handler} or {@link streamHandler}.
 */
export interface Handler {
  /** The name of the kind this handler serves. */
  readonly kind: string;
  /** Decode the payload, run the handler, and encode each reply; never fails. */
  readonly serve: (payload: unknown) => Stream.Stream<MirrorProtocol.HostResponseOutcome>;
}

/** The handlers a host serves, by kind name. */
export type Registry = HashMap.HashMap<string, Handler>;

/** Index handlers by kind; a later handler for a name replaces an earlier one. */
export const registry = (handlers: ReadonlyArray<Handler>): Registry =>
  HashMap.fromIterable(handlers.map((entry) => [entry.kind, entry] as const));

/** The text of a failure cause, for a `Failed` reply: its error's message, or its rendering. */
const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return P.hasProperty(error, "message") && P.isString(error.message)
    ? error.message
    : String(error);
};

const failure = (
  reason: MirrorProtocol.HostFailureReason,
  message: string
): MirrorProtocol.HostResponseOutcome => ({ _tag: "Failure", reason, message });

const END: MirrorProtocol.HostResponseOutcome = { _tag: "End" };

/** A handler's failure as its `Failed` reply; an interruption alone sends nothing (the request was cancelled). */
const failedOf = (cause: Cause.Cause<unknown>): Stream.Stream<MirrorProtocol.HostResponseOutcome> =>
  Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.make(failure("Failed", messageOf(cause)));

/** Decode a payload against a kind's request schema, as `InvalidRequest` on failure. */
const decodeInput = <I, O>(kind: Kind<I, O>, payload: unknown) =>
  Schema.decodeUnknownEffect(kind.request)(payload).pipe(
    Effect.mapError((error) => failure("InvalidRequest", error.message))
  );

/**
 * Serve one request: decode its payload (an `InvalidRequest` reply when it
 * does not fit), answer it, and turn a failure or defect into a `Failed` reply.
 */
const serveDecoded = <I, O, E>(
  kind: Kind<I, O>,
  payload: unknown,
  answer: (input: I) => Stream.Stream<MirrorProtocol.HostResponseOutcome, E>
): Stream.Stream<MirrorProtocol.HostResponseOutcome> =>
  Stream.unwrap(
    decodeInput(kind, payload).pipe(
      Effect.match({
        onFailure: (refusal) => Stream.make(refusal),
        onSuccess: (input) => answer(input).pipe(Stream.catchCause(failedOf)),
      })
    )
  );

/** Serve a single-reply kind: its `Value`, or a `Failure` when the handler fails or dies. */
export const handler = <I, O, E>(
  kind: Single<I, O>,
  run: (input: I) => Effect.Effect<O, E>
): Handler => ({
  kind: kind.name,
  serve: (payload) =>
    serveDecoded(kind, payload, (input) =>
      Stream.fromEffect(
        run(input).pipe(
          Effect.flatMap(Schema.encodeEffect(kind.response)),
          Effect.map((value): MirrorProtocol.HostResponseOutcome => ({ _tag: "Value", value }))
        )
      )
    ),
});

/** Serve a streaming kind: each element as an `Item`, then `End`, or a `Failure` when the stream fails or dies. */
export const streamHandler = <I, O, E>(
  kind: Streaming<I, O>,
  run: (input: I) => Stream.Stream<O, E>
): Handler => ({
  kind: kind.name,
  serve: (payload) =>
    serveDecoded(kind, payload, (input) =>
      run(input).pipe(
        Stream.mapEffect((value) => Schema.encodeEffect(kind.response)(value)),
        Stream.map((value): MirrorProtocol.HostResponseOutcome => ({ _tag: "Item", value })),
        Stream.concat(Stream.make(END))
      )
    ),
});

/** The reply a host sends for a kind it does not serve. */
export const unknownKind = (kind: string): MirrorProtocol.HostResponseOutcome =>
  failure("UnknownKind", `The engine host serves no request kind "${kind}"`);

/** Encode a mirror's input against a kind's request schema; a value that does not fit is `InvalidRequest`. */
export const encodeRequest = <I, O>(
  kind: Kind<I, O>,
  input: I
): Effect.Effect<unknown, HostRequestError> =>
  Schema.encodeEffect(kind.request)(input).pipe(
    Effect.mapError(
      (error) =>
        new HostRequestError({ kind: kind.name, reason: "InvalidRequest", message: error.message })
    )
  );

/** Decode one reply value against a kind's response schema; a value that does not decode is `Failed`. */
export const decodeResponse = <I, O>(
  kind: Kind<I, O>,
  value: unknown
): Effect.Effect<O, HostRequestError> =>
  Schema.decodeUnknownEffect(kind.response)(value).pipe(
    Effect.mapError(
      (error) =>
        new HostRequestError({
          kind: kind.name,
          reason: "Failed",
          message: `The host's reply did not decode: ${error.message}`,
        })
    )
  );

/**
 * One reply as its caller sees it: a `Value` or `Item` decoded against the
 * kind's response schema, a `Failure` as its {@link HostRequestError}, and an
 * `End` where a value was due as `Failed`.
 */
export const replyValue = <I, O>(
  kind: Kind<I, O>,
  outcome: MirrorProtocol.HostResponseOutcome
): Effect.Effect<O, HostRequestError> =>
  Match.valueTags(outcome, {
    Value: ({ value }) => decodeResponse(kind, value),
    Item: ({ value }) => decodeResponse(kind, value),
    Failure: ({ reason, message }) =>
      Effect.fail(new HostRequestError({ kind: kind.name, reason, message })),
    End: () =>
      Effect.fail(
        new HostRequestError({
          kind: kind.name,
          reason: "Failed",
          message: "The host ended the request without a value",
        })
      ),
  });

/** A request no host answered: the mirror's `Unanswered` failure. */
export const unanswered = (kind: string, message: string): HostRequestError =>
  new HostRequestError({ kind, reason: "Unanswered", message });
