/**
 * Transport status combinators: `withInferredStatus` derives real
 * connectivity from observed push/pull behaviour (the default RPC carrier
 * reports permanently "connected"), and `withFallback` layers a fallback
 * carrier under a primary with a sideline cooldown, merged pokes, and
 * inferred status. Version rejections propagate without touching either.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Ref, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { TransportError, VersionNotSupportedError } from "../Errors.js";
import type { PullRequest, PullResponse, PushResponse } from "../Protocol.js";
import * as Transport from "../Transport.js";

const pullResponse: PullResponse = { cookie: "next", patch: [], lastMutationIds: {} };
const pushResponse: PushResponse = { lastMutationIds: {} };
const pullRequest: PullRequest = {
  clientGroupId: "g",
  subscriptions: [],
} as unknown as PullRequest;

interface Fake {
  readonly transport: Transport.ClientTransport;
  readonly failing: Ref.Ref<boolean>;
  readonly pulls: Ref.Ref<number>;
}

/** A fake carrier with a failure switch, a pull counter, and given pokes. */
const makeFake = (
  pokes: Stream.Stream<{ readonly reason?: string }, TransportError> = Stream.empty,
  error: () => TransportError | VersionNotSupportedError = () =>
    new TransportError({ message: "carrier down" })
): Effect.Effect<Fake> =>
  Effect.gen(function* () {
    const failing = yield* Ref.make(false);
    const pulls = yield* Ref.make(0);
    const attempt = <A>(value: A): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      Effect.flatMap(Ref.get(failing), (down) =>
        down ? Effect.fail(error()) : Effect.succeed(value)
      );
    return {
      failing,
      pulls,
      transport: {
        push: () => attempt(pushResponse),
        pull: () => Ref.update(pulls, (n) => n + 1).pipe(Effect.andThen(attempt(pullResponse))),
        pokes,
        status: Effect.succeed("connected" as const),
        statusChanges: Stream.succeed("connected" as const),
      },
    };
  });

describe("Transport.withInferredStatus", () => {
  it.effect("starts connecting, then tracks observed successes and failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFake();
        const wrapped = yield* Transport.withInferredStatus(fake.transport);

        expect(yield* wrapped.status).toBe("connecting");
        const first = yield* Stream.runHead(Stream.take(wrapped.statusChanges, 1));
        expect(first).toMatchObject({ _tag: "Some", value: "connecting" });

        yield* wrapped.pull(pullRequest);
        expect(yield* wrapped.status).toBe("connected");

        yield* Ref.set(fake.failing, true);
        const failed = yield* Effect.flip(wrapped.pull(pullRequest));
        expect(failed._tag).toBe("TransportError");
        expect(yield* wrapped.status).toBe("disconnected");

        yield* Ref.set(fake.failing, false);
        yield* wrapped.push({} as never);
        expect(yield* wrapped.status).toBe("connected");
      })
    )
  );
});

describe("Transport.withFallback", () => {
  it.effect("serves through the fallback and sidelines the failed primary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const primary = yield* makeFake();
        const fallback = yield* makeFake();
        const combined = yield* Transport.withFallback(primary.transport, fallback.transport, {
          restoreAfter: "30 seconds",
        });

        yield* Ref.set(primary.failing, true);

        // First call probes the primary, falls back, still "connected".
        expect(yield* combined.pull(pullRequest)).toEqual(pullResponse);
        expect(yield* Ref.get(primary.pulls)).toBe(1);
        expect(yield* Ref.get(fallback.pulls)).toBe(1);
        expect(yield* combined.status).toBe("connected");

        // While sidelined, calls skip the primary entirely.
        yield* combined.pull(pullRequest);
        expect(yield* Ref.get(primary.pulls)).toBe(1);
        expect(yield* Ref.get(fallback.pulls)).toBe(2);

        // After the cooldown a call probes the (recovered) primary again.
        yield* TestClock.adjust("31 seconds");
        yield* Ref.set(primary.failing, false);
        expect(yield* combined.pull(pullRequest)).toEqual(pullResponse);
        expect(yield* Ref.get(primary.pulls)).toBe(2);
        expect(yield* Ref.get(fallback.pulls)).toBe(2);
      })
    )
  );

  it.effect("exhausting both carriers fails and reports disconnected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const primary = yield* makeFake();
        const fallback = yield* makeFake();
        const combined = yield* Transport.withFallback(primary.transport, fallback.transport);
        yield* Ref.set(primary.failing, true);
        yield* Ref.set(fallback.failing, true);

        const failed = yield* Effect.flip(combined.pull(pullRequest));
        expect(failed._tag).toBe("TransportError");
        expect(yield* combined.status).toBe("disconnected");

        // Recovery through the fallback flips back to connected.
        yield* Ref.set(fallback.failing, false);
        yield* combined.pull(pullRequest);
        expect(yield* combined.status).toBe("connected");
      })
    )
  );

  it.effect("a version rejection propagates without falling back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const primary = yield* makeFake(
          Stream.empty,
          () => new VersionNotSupportedError({ message: "update required" })
        );
        const fallback = yield* makeFake();
        const combined = yield* Transport.withFallback(primary.transport, fallback.transport);
        yield* Ref.set(primary.failing, true);

        const failed = yield* Effect.flip(combined.pull(pullRequest));
        expect(failed._tag).toBe("VersionNotSupportedError");
        expect(yield* Ref.get(fallback.pulls)).toBe(0);
      })
    )
  );

  it.effect("a hanging primary is timed out, sidelined, and served by the fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fallback = yield* makeFake();
        const hangs = yield* Ref.make(0);
        const hanging: Transport.ClientTransport = {
          push: () => Effect.never,
          pull: () => Ref.update(hangs, (n) => n + 1).pipe(Effect.andThen(Effect.never)),
          pokes: Stream.empty,
          status: Effect.succeed("connected" as const),
          statusChanges: Stream.succeed("connected" as const),
        };
        const combined = yield* Transport.withFallback(hanging, fallback.transport, {
          primaryTimeout: "5 seconds",
          restoreAfter: "30 seconds",
        });

        const fiber = yield* Effect.forkScoped(combined.pull(pullRequest));
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(fiber)).toEqual(pullResponse);
        expect(yield* Ref.get(hangs)).toBe(1);
        expect(yield* Ref.get(fallback.pulls)).toBe(1);
        expect(yield* combined.status).toBe("connected");

        // While sidelined, calls skip the hanging primary entirely — no
        // timeout wait on every call.
        yield* combined.pull(pullRequest);
        expect(yield* Ref.get(hangs)).toBe(1);
        expect(yield* Ref.get(fallback.pulls)).toBe(2);
      })
    )
  );

  it.effect("merges pokes and survives a failing primary poke stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const primary = yield* makeFake(
          Stream.concat(
            Stream.succeed({ reason: "primary" }),
            Stream.fail(new TransportError({ message: "socket died" }))
          )
        );
        const fallback = yield* makeFake(Stream.succeed({ reason: "fallback" }));
        const combined = yield* Transport.withFallback(primary.transport, fallback.transport);

        const pokes = yield* Stream.runCollect(Stream.take(combined.pokes, 2));
        const reasons = [...pokes].map((poke) => poke.reason).toSorted();
        expect(reasons).toEqual(["fallback", "primary"]);
      })
    )
  );
});

describe("Transport.simulateOffline", () => {
  it.effect("passes calls through while online, fails them while toggled offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFake();
        const { transport, setOffline } = yield* Transport.simulateOffline(fake.transport);

        expect(yield* transport.pull(pullRequest)).toEqual(pullResponse);

        yield* setOffline(true);
        const failed = yield* Effect.flip(transport.pull(pullRequest));
        expect(failed._tag).toBe("TransportError");
        // The underlying carrier is never even called while the gate is closed.
        expect(yield* Ref.get(fake.pulls)).toBe(1);

        yield* setOffline(false);
        expect(yield* transport.pull(pullRequest)).toEqual(pullResponse);
        expect(yield* Ref.get(fake.pulls)).toBe(2);
      })
    )
  );

  // Real clock: the collector subscribes to two combined SubscriptionRef-backed
  // streams on a background fiber, so give it a turn to establish before the
  // toggles fire (mirrors mutation-states-engine.test.ts's own live-collector
  // pattern) — a TestClock would freeze the fiber's subscribe race instead of
  // resolving it.
  it.live(
    "status/statusChanges report disconnected while offline, else the wrapped transport's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const { transport, setOffline, isOffline } = yield* Transport.simulateOffline(
            fake.transport
          );

          expect(yield* isOffline).toBe(false);
          expect(yield* transport.status).toBe("connected");

          const changes = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(transport.statusChanges, 3))
          );
          yield* Effect.sleep(Duration.millis(20));

          yield* setOffline(true);
          expect(yield* transport.status).toBe("disconnected");
          yield* setOffline(false);
          expect(yield* transport.status).toBe("connected");

          const seen = [...(yield* Fiber.join(changes).pipe(Effect.timeout(Duration.seconds(2))))];
          expect(seen).toEqual(["connected", "disconnected", "connected"]);
        })
      )
  );
});
