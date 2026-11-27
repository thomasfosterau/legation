/**
 * Wire round trips over generated messages: every sync-protocol message
 * survives encode, JSON text and decode, and every mirror and host message
 * survives encode, structured clone and decode, as their channels carry them.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as Protocol from "../Protocol.js";
import * as Json from "../internal/Json.js";

/** Whether a JSON value holds a `-0`, which JSON text reads back as `0`. */
const hasNegativeZero = (json: Schema.Json): boolean => {
  if (P.isNumber(json)) return Object.is(json, -0);
  if (Arr.isArray<Schema.Json>(json)) return json.some(hasNegativeZero);
  if (json === null || P.isString(json) || P.isBoolean(json)) return false;
  return R.values(json).some(hasNegativeZero);
};

const isJson = Schema.is(Schema.Json);

/**
 * A wire message's round trip through JSON text: encode, stringify, parse,
 * decode. `Schema.Number` admits `NaN`, the infinities and `-0`, which JSON
 * text cannot carry, so the messages are drawn from those it can.
 */
const overJson = (name: string, schema: Schema.Codec<unknown, unknown>) => {
  const encode = Schema.encodeSync(schema);
  const carried = Arbitrary.schema(schema).pipe(
    Arbitrary.filter((value) => {
      const encoded = encode(value);
      return isJson(encoded) && !hasNegativeZero(encoded);
    })
  );
  it.effect.prop(name, [carried], ([value]) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(schema)(value);
      const decoded = yield* Schema.decodeEffect(schema)(Json.parse(Json.stringify(encoded)));
      expect(decoded).toEqual(value);
    })
  );
};

describe("Protocol messages round-trip through JSON text", () => {
  overJson("PushRequest", Protocol.PushRequest);
  overJson("PushResponse", Protocol.PushResponse);
  overJson("PullRequest", Protocol.PullRequest);
  overJson("PullResponse", Protocol.PullResponse);
  overJson("ReadRequest", Protocol.ReadRequest);
  overJson("ReadResponse", Protocol.ReadResponse);
  overJson("Poke", Protocol.Poke);
});

describe("MirrorProtocol messages round-trip through structured clone", () => {
  it.effect.prop("a mirror message", [MirrorProtocol.MirrorMessageSchema], ([value]) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(MirrorProtocol.MirrorMessageSchema)(value);
      expect(yield* MirrorProtocol.decodeMirrorMessage(structuredClone(encoded))).toEqual(value);
    })
  );

  it.effect.prop("a host message", [MirrorProtocol.HostMessageSchema], ([value]) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(MirrorProtocol.HostMessageSchema)(value);
      expect(yield* MirrorProtocol.decodeHostMessage(structuredClone(encoded))).toEqual(value);
    })
  );
});
