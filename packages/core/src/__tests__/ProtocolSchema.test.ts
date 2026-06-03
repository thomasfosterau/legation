import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as ProtocolSchema from "../ProtocolSchema.js";
import * as Protocol from "../Protocol.js";
import type { ProtocolError } from "../Errors.js";

const decodeClient = (input: unknown): Result.Result<Protocol.ClientMessage, unknown> =>
  Effect.runSync(Effect.result(ProtocolSchema.decodeClientMessage(input)));

const decodeServer = (input: unknown): Result.Result<Protocol.ServerMessage, unknown> =>
  Effect.runSync(Effect.result(ProtocolSchema.decodeServerMessage(input)));

const failureOf = <A>(result: Result.Result<A, ProtocolError>): ProtocolError | undefined =>
  Result.isFailure(result) ? result.failure : undefined;

const roundTripClient = (msg: Protocol.ClientMessage): Protocol.ClientMessage =>
  Effect.runSync(ProtocolSchema.parseClientMessage(JSON.stringify(msg)));

const roundTripServer = (msg: Protocol.ServerMessage): Protocol.ServerMessage =>
  Effect.runSync(ProtocolSchema.parseServerMessage(JSON.stringify(msg)));

const wireEntry: Protocol.WireEntry = {
  key: ["users", "1"],
  value: { name: "Ada" },
  version: 3,
  updatedAt: 1000,
};

const clientMessages: ReadonlyArray<Protocol.ClientMessage> = [
  { _tag: "Subscribe", id: "m1", filter: { _tag: "Prefix", prefix: ["users"] } },
  { _tag: "Unsubscribe", id: "m2", filter: { _tag: "Exact", key: ["users", "1"] } },
  {
    _tag: "Push",
    id: "m3",
    mutations: [
      { mutationId: "x", key: ["users", "1"], input: { name: "Bo" }, baseVersion: 2 },
      { mutationId: "y", key: ["users", "2"], input: 42 },
    ],
  },
  { _tag: "Pull", id: "m4", keys: [["users", "1"], ["posts"]] },
  { _tag: "Ping", id: "m5" },
];

const serverMessages: ReadonlyArray<Protocol.ServerMessage> = [
  { _tag: "Updated", entry: wireEntry },
  { _tag: "Removed", key: ["users", "1"], version: "v9" },
  { _tag: "Invalidated", filter: { _tag: "Prefix", prefix: ["users"] } },
  { _tag: "SubscribeAck", id: "m1" },
  { _tag: "UnsubscribeAck", id: "m2" },
  {
    _tag: "PushAck",
    id: "m3",
    results: [
      { _tag: "Applied", mutationId: "x", entry: wireEntry },
      { _tag: "Conflict", mutationId: "y", key: ["users", "2"], serverEntry: wireEntry },
      { _tag: "Rejected", mutationId: "z", key: ["users", "3"], reason: "nope" },
    ],
  },
  { _tag: "PullAck", id: "m4", entries: [wireEntry] },
  { _tag: "Pong", id: "m5" },
  { _tag: "ProtocolFailure", id: "m6", reason: "boom" },
  { _tag: "ProtocolFailure", id: null, reason: "no correlation" },
];

describe("ProtocolSchema", () => {
  describe("ClientMessage round-trips", () => {
    for (const msg of clientMessages) {
      it(`round-trips ${msg._tag}`, () => {
        expect(roundTripClient(msg)).toEqual(msg);
      });
    }
  });

  describe("ServerMessage round-trips", () => {
    for (const msg of serverMessages) {
      it(`round-trips ${msg._tag}${"id" in msg && msg.id === null ? " (null id)" : ""}`, () => {
        expect(roundTripServer(msg)).toEqual(msg);
      });
    }
  });

  it("round-trips a SyncKey with nested object and array parts", () => {
    const msg: Protocol.ClientMessage = {
      _tag: "Pull",
      id: "deep",
      keys: [["users", { filter: { active: true }, page: 2 }, ["nested", 1, false, null]]],
    };
    expect(roundTripClient(msg)).toEqual(msg);
  });

  it("preserves arbitrary value payloads", () => {
    const msg: Protocol.ServerMessage = {
      _tag: "Updated",
      entry: { key: ["k"], value: { a: [1, 2, { b: null }] }, version: "v1", updatedAt: 5 },
    };
    expect(roundTripServer(msg)).toEqual(msg);
  });

  describe("rejects garbage", () => {
    it("rejects a missing _tag", () => {
      expect(Result.isFailure(decodeClient({ id: "x" }))).toBe(true);
    });

    it("rejects an unknown _tag", () => {
      expect(Result.isFailure(decodeClient({ _tag: "Nope", id: "x" }))).toBe(true);
    });

    it("rejects a wrong field type (id must be a string)", () => {
      expect(Result.isFailure(decodeClient({ _tag: "Ping", id: 42 }))).toBe(true);
    });

    it("rejects a non-array SyncKey", () => {
      expect(
        Result.isFailure(
          decodeClient({ _tag: "Subscribe", id: "x", filter: { _tag: "Exact", key: "not-array" } })
        )
      ).toBe(true);
    });

    it("rejects a non-object input", () => {
      expect(Result.isFailure(decodeServer(42))).toBe(true);
      expect(Result.isFailure(decodeServer(null))).toBe(true);
      expect(Result.isFailure(decodeServer("string"))).toBe(true);
    });

    it("rejects a malformed nested WireEntry", () => {
      expect(
        Result.isFailure(
          decodeServer({ _tag: "Updated", entry: { key: ["k"], value: 1, updatedAt: 0 } })
        )
      ).toBe(true);
    });
  });

  describe("parse maps JSON failures to ProtocolError", () => {
    it("fails on malformed JSON", () => {
      const failure = failureOf(
        Effect.runSync(Effect.result(ProtocolSchema.parseClientMessage("{not json")))
      );
      expect(failure?._tag).toBe("ProtocolError");
    });

    it("fails on structurally invalid JSON", () => {
      const failure = failureOf(
        Effect.runSync(
          Effect.result(ProtocolSchema.parseServerMessage(JSON.stringify({ _tag: "Bogus" })))
        )
      );
      expect(failure?._tag).toBe("ProtocolError");
      expect(failure?.cause).toBeDefined();
    });
  });
});
