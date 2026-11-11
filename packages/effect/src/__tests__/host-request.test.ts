/**
 * The host-request envelope (ADR-0021 amendment, #146, #136): a mirror asks
 * its host a typed request kind and the host answers from its registry. A
 * single-reply kind round-trips one `Value`, a streaming kind its `Item`s and
 * `End`; every failure is a reply (`UnknownKind`, `InvalidRequest`, `Failed`);
 * a mirror never waits forever (`Unanswered` on its timeout, on a host
 * restart, and from a host that predates the envelope); a consumer that stops
 * cancels the host's stream, as does the mirror's `Disconnect`; and a reply
 * addressed to another mirror is not taken.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngine from "../ClientEngine.js";
import * as ClientStore from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as EngineHost from "../EngineHost.js";
import type { TransportError } from "../Errors.js";
import * as HostRequest from "../HostRequest.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mirror from "../Mirror.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as Mutator from "../Mutator.js";
import * as SyncServer from "../SyncServer.js";
import * as Transport from "../Transport.js";

const mutators = Mutator.registry([]);

const double = HostRequest.single("test/double", {
  request: Schema.Struct({ n: Schema.Finite }),
  response: Schema.Struct({ doubled: Schema.Finite }),
});
// The same name declared looser on the mirror, so a payload the host's
// schema refuses reaches the host.
const doubleLoose = HostRequest.single("test/double", {
  request: Schema.Unknown,
  response: Schema.Struct({ doubled: Schema.Finite }),
});
const failing = HostRequest.single("test/failing", {
  request: HostRequest.NoInput,
  response: HostRequest.Done,
});
const dying = HostRequest.single("test/dying", {
  request: HostRequest.NoInput,
  response: HostRequest.Done,
});
const unserved = HostRequest.single("test/unserved", {
  request: HostRequest.NoInput,
  response: HostRequest.Done,
});
const count = HostRequest.streaming("test/count", {
  request: Schema.Struct({ to: Schema.Finite }),
  response: Schema.Finite,
});
const endless = HostRequest.streaming("test/endless", {
  request: HostRequest.NoInput,
  response: Schema.Finite,
});

/** What the test handlers fail and die with. */
class HandlerError extends Schema.TaggedError<HandlerError, { readonly brand: unique symbol }>()(
  "HandlerError",
  { message: Schema.String }
) {}

const makeEngine = Effect.fn("makeEngine")(function* () {
  const backend = yield* MemoryBackend.make({});
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(Authorization.AuthPolicy, Authorization.policy({})),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  return yield* ClientEngine.make({ clientId: "host-a", clientGroupId: "group-a", mutators }).pipe(
    Effect.provideService(ClientStore.ClientStore, yield* ClientStore.makeMemory),
    Effect.provideService(Transport.ClientTransport, transport)
  );
});

/** A mirror channel that also records every message the mirror posts. */
const recording = (channel: MirrorChannel.MirrorChannel) =>
  Effect.gen(function* () {
    const posted = yield* Ref.make<ReadonlyArray<MirrorProtocol.MirrorMessage>>([]);
    const spied: MirrorChannel.MirrorChannel = {
      subscribe: channel.subscribe,
      post: (message) =>
        MirrorProtocol.decodeMirrorMessage(message).pipe(
          Effect.flatMap((decoded) =>
            decoded === undefined
              ? Effect.void
              : Ref.update(posted, (messages) => [...messages, decoded])
          ),
          Effect.andThen(channel.post(message))
        ),
    };
    return { channel: spied, posted };
  });

/** A real host serving the test kinds, a recorded mirror channel, and the endless stream's hooks. */
const setup = Effect.fn("setup")(function* () {
  const engine = yield* makeEngine();
  const pair = yield* MirrorChannel.makeLoopbackPair;
  const endlessStarted = yield* Deferred.make<void>();
  const endlessStopped = yield* Deferred.make<void>();
  yield* EngineHost.run({
    channel: pair.host,
    engine,
    requests: [
      HostRequest.handler(double, ({ n }) => Effect.succeed({ doubled: n * 2 })),
      HostRequest.handler(failing, () =>
        Effect.fail(new HandlerError({ message: "the handler failed" }))
      ),
      HostRequest.handler(dying, () =>
        Effect.die(new HandlerError({ message: "the handler died" }))
      ),
      HostRequest.streamHandler(count, ({ to }) => Stream.range(1, to)),
      HostRequest.streamHandler(endless, () =>
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(endlessStarted, undefined).pipe(Effect.as(0))),
          Stream.never
        ).pipe(Stream.ensuring(Deferred.succeed(endlessStopped, undefined)))
      ),
    ],
  });
  const { channel, posted } = yield* recording(pair.mirror);
  const mirror = yield* Mirror.make({ channel, mutators });
  return { pair, mirror, posted, endlessStarted, endlessStopped };
});

/** How a request ended: `success`, its failure's reason, or `defect`. */
const reasonOf = <A>(exit: Exit.Exit<A, HostRequest.HostRequestError>): string =>
  Exit.isSuccess(exit)
    ? "success"
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => error.reason,
      });

type HostRequestMessage = Extract<MirrorProtocol.MirrorMessage, { readonly _tag: "HostRequest" }>;
const isHostRequest = (message: unknown): message is HostRequestMessage =>
  P.isTagged(message, "HostRequest");

/**
 * A scripted host on `channel`: runs `answer` on every
 * `HostRequest` a mirror posts and ignores everything else (a host that
 * predates the envelope is one whose `answer` does nothing).
 */
const scriptedHost = (
  channel: MirrorChannel.MirrorChannel,
  answer: (message: HostRequestMessage) => Effect.Effect<unknown, TransportError>
) =>
  Effect.gen(function* () {
    const inbox = yield* channel.subscribe;
    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap(MirrorProtocol.decodeMirrorMessage),
          Effect.flatMap((message) =>
            isHostRequest(message) ? Effect.ignore(answer(message)) : Effect.void
          )
        )
      )
    );
  });

describe("host requests (ADR-0021 amendment)", () => {
  it.effect("a single-reply kind round-trips its typed Value", () =>
    Effect.gen(function* () {
      const { mirror } = yield* setup();
      expect(yield* mirror.request(double, { n: 21 })).toEqual({ doubled: 42 });
    })
  );

  it.effect("a streaming kind round-trips its Items and End", () =>
    Effect.gen(function* () {
      const { mirror } = yield* setup();
      expect(yield* Stream.runCollect(mirror.stream(count, { to: 3 }))).toEqual([1, 2, 3]);
    })
  );

  it.effect("a kind the host does not serve is UnknownKind", () =>
    Effect.gen(function* () {
      const { mirror } = yield* setup();
      const exit = yield* Effect.exit(mirror.request(unserved, {}));
      expect(reasonOf(exit)).toBe("UnknownKind");
    })
  );

  it.effect("a payload the kind's request schema refuses is InvalidRequest", () =>
    Effect.gen(function* () {
      const { mirror } = yield* setup();
      const exit = yield* Effect.exit(mirror.request(doubleLoose, { n: "not a number" }));
      expect(reasonOf(exit)).toBe("InvalidRequest");
    })
  );

  it.effect("a handler that fails, or dies, is Failed with its message", () =>
    Effect.gen(function* () {
      const { mirror } = yield* setup();
      const failed = yield* Effect.flip(mirror.request(failing, {}));
      expect(failed.reason).toBe("Failed");
      expect(failed.message).toContain("the handler failed");
      const died = yield* Effect.flip(mirror.request(dying, {}));
      expect(died.reason).toBe("Failed");
      expect(died.message).toContain("the handler died");
    })
  );

  it.effect("a consumer that stops early cancels the host's stream", () =>
    Effect.gen(function* () {
      const { mirror, posted, endlessStopped } = yield* setup();
      expect(yield* Stream.runHead(mirror.stream(endless, {}))).toEqual(Option.some(0));
      yield* Deferred.await(endlessStopped);
      const messages = yield* Ref.get(posted);
      expect(messages.some((message) => P.isTagged(message, "HostRequestCancel"))).toBe(true);
    })
  );

  it.effect("an interrupted consumer cancels the host's stream", () =>
    Effect.gen(function* () {
      const { mirror, endlessStarted, endlessStopped } = yield* setup();
      const consumer = yield* Effect.forkChild(Stream.runDrain(mirror.stream(endless, {})));
      yield* Deferred.await(endlessStarted);
      yield* Fiber.interrupt(consumer);
      yield* Deferred.await(endlessStopped);
    })
  );

  it.effect("the mirror's Disconnect cancels every request it holds", () =>
    Effect.gen(function* () {
      const { pair, mirror, posted, endlessStarted, endlessStopped } = yield* setup();
      yield* Effect.forkChild(Stream.runDrain(mirror.stream(endless, {})));
      yield* Deferred.await(endlessStarted);
      const request = (yield* Ref.get(posted)).find(isHostRequest);
      expect(request).toBeDefined();
      if (request === undefined) return;
      // As the liveness sweep would for a mirror that went silent.
      yield* pair.mirror.post({ _tag: "Disconnect", mirrorId: request.mirrorId });
      yield* Deferred.await(endlessStopped);
    })
  );

  it.live("a request with no answer is Unanswered after the mirror's timeout", () =>
    Effect.gen(function* () {
      const pair = yield* MirrorChannel.makeLoopbackPair;
      // A host that predates the envelope: it drops every HostRequest.
      yield* scriptedHost(pair.host, () => Effect.void);
      const mirror = yield* Mirror.make({
        channel: pair.mirror,
        mutators,
        requestTimeout: "50 millis",
      });
      const exit = yield* Effect.exit(mirror.request(double, { n: 1 }));
      expect(reasonOf(exit)).toBe("Unanswered");
    })
  );

  it.effect("a host restart fails every request in flight with Unanswered", () =>
    Effect.gen(function* () {
      const pair = yield* MirrorChannel.makeLoopbackPair;
      const received = yield* Deferred.make<void>();
      yield* scriptedHost(pair.host, () => Deferred.succeed(received, undefined));
      const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
      // The host's first announcement; the one after the request is its restart.
      yield* pair.host.post({ _tag: "HostReady" });
      const single = yield* Effect.forkChild(Effect.exit(mirror.request(double, { n: 1 })));
      yield* Deferred.await(received);
      yield* pair.host.post({ _tag: "HostReady" });
      expect(reasonOf(yield* Fiber.join(single))).toBe("Unanswered");
    })
  );

  it.effect("a host restart fails a stream in flight with Unanswered", () =>
    Effect.gen(function* () {
      const pair = yield* MirrorChannel.makeLoopbackPair;
      const received = yield* Deferred.make<void>();
      yield* scriptedHost(pair.host, () => Deferred.succeed(received, undefined));
      const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
      yield* pair.host.post({ _tag: "HostReady" });
      const followed = yield* Effect.forkChild(
        Effect.exit(Stream.runDrain(mirror.stream(count, { to: 3 })))
      );
      yield* Deferred.await(received);
      yield* pair.host.post({ _tag: "HostReady" });
      expect(reasonOf(yield* Fiber.join(followed))).toBe("Unanswered");
    })
  );

  it.effect("a reply addressed to another mirror is ignored", () =>
    Effect.gen(function* () {
      const pair = yield* MirrorChannel.makeLoopbackPair;
      yield* scriptedHost(pair.host, (message) =>
        pair.host
          .post({
            _tag: "HostResponse",
            mirrorId: "another-tab",
            requestId: message.requestId,
            outcome: { _tag: "Value", value: { doubled: -1 } },
          })
          .pipe(
            Effect.andThen(
              pair.host.post({
                _tag: "HostResponse",
                mirrorId: message.mirrorId,
                requestId: message.requestId,
                outcome: { _tag: "Value", value: { doubled: 2 } },
              })
            )
          )
      );
      const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
      expect(yield* mirror.request(double, { n: 1 })).toEqual({ doubled: 2 });
    })
  );

  it.effect("an input the mirror cannot encode is InvalidRequest, and is never sent", () =>
    Effect.gen(function* () {
      const { mirror, posted } = yield* setup();
      // `Finite` refuses NaN on encoding as on decoding.
      const exit = yield* Effect.exit(mirror.request(double, { n: Number.NaN }));
      expect(reasonOf(exit)).toBe("InvalidRequest");
      expect((yield* Ref.get(posted)).some(isHostRequest)).toBe(false);
    })
  );
});
