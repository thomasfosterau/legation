/**
 * Transport status combinators: `withInferredStatus` derives real
 * connectivity from observed push/pull behaviour (the default RPC carrier
 * reports permanently "connected"), and `withFallback` layers a fallback
 * carrier under a primary with a sideline cooldown, merged pokes, and
 * inferred status. Version rejections propagate without touching either.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { TransportError, VersionNotSupportedError } from "../Errors.js";
import type { PullRequest, PullResponse, PushResponse } from "../Protocol.js";
import * as Transport from "../Transport.js";

const pullResponse: PullResponse = { cookie: "next", patch: [], lastMutationIds: {} };
const pushResponse: PushResponse = { lastMutationIds: {} };
const pullRequest: PullRequest = {
  clientGroupId: "g",
  subscriptions: [],
};

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

/**
 * Yields to the scheduler until a collector has recorded `count` statuses.
 * The bound is a number of scheduler turns, not a wall-clock budget, so
 * machine load cannot exhaust it; a missing change dies with a clear message
 * instead of hanging the test.
 */
const awaitSeen = (
  seen: Ref.Ref<ReadonlyArray<Transport.ConnectionStatus>>,
  count: number,
  maxTurns = 1_000
) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < maxTurns; turn++) {
      if ((yield* Ref.get(seen)).length >= count) return;
      yield* Effect.yieldNow;
    }
    const all = yield* Ref.get(seen);
    if (all.length >= count) return;
    return yield* Effect.die(
      new Error(`awaitSeen: ${count} statuses never arrived in ${maxTurns} turns; saw ${all}`)
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

  // The collector runs on a background fiber. Waiting for it to record the
  // current status proves it is subscribed: `SubscriptionRef.changes` replays
  // the current value only to a live subscriber, so by then both streams
  // `statusChanges` combines are subscribed and no toggle below can be missed.
  // Each step then waits for the collector to record the change. No sleep and
  // no clock, so a loaded machine cannot reorder a step (#284), and every wait
  // is bounded in scheduler turns, so a missing status fails instead of
  // hanging (#325).
  it.effect(
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

          const seen = yield* Ref.make<ReadonlyArray<Transport.ConnectionStatus>>([]);
          yield* Effect.forkScoped(
            Stream.runForEach(transport.statusChanges, (status) =>
              Ref.update(seen, (all) => [...all, status])
            )
          );
          yield* awaitSeen(seen, 1);
          expect(yield* Ref.get(seen)).toEqual(["connected"]);

          yield* setOffline(true);
          expect(yield* transport.status).toBe("disconnected");
          yield* awaitSeen(seen, 2);
          expect(yield* Ref.get(seen)).toEqual(["connected", "disconnected"]);

          yield* setOffline(false);
          expect(yield* transport.status).toBe("connected");
          yield* awaitSeen(seen, 3);
          expect(yield* Ref.get(seen)).toEqual(["connected", "disconnected", "connected"]);
        })
      )
  );

  // The wrapped transport's own status keeps changing while the gate is
  // closed, and each change reaches the combiner, which maps it to
  // "disconnected" again. `statusChanges` must not repeat it. `delivered`
  // records each wrapped status as the combiner pulls it. Each change waits
  // for the previous one to be pulled, so each arrives in its own pull; the
  // wrapped stream runs on one fiber, so once it has pulled the second change,
  // the first has been combined and passed on, ahead of the toggle back
  // online. Without the dedupe, that first change repeats "disconnected".
  it.effect(
    "statusChanges does not repeat disconnected while the wrapped status changes offline",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const real = yield* SubscriptionRef.make<Transport.ConnectionStatus>("connected");
          const delivered = yield* Ref.make<ReadonlyArray<Transport.ConnectionStatus>>([]);
          const { transport, setOffline } = yield* Transport.simulateOffline({
            ...fake.transport,
            status: SubscriptionRef.get(real),
            statusChanges: SubscriptionRef.changes(real).pipe(
              Stream.tap((status) => Ref.update(delivered, (all) => [...all, status]))
            ),
          });

          const seen = yield* Ref.make<ReadonlyArray<Transport.ConnectionStatus>>([]);
          yield* Effect.forkScoped(
            Stream.runForEach(transport.statusChanges, (status) =>
              Ref.update(seen, (all) => [...all, status])
            )
          );
          yield* awaitSeen(seen, 1);
          expect(yield* Ref.get(seen)).toEqual(["connected"]);

          yield* setOffline(true);
          yield* awaitSeen(seen, 2);
          expect(yield* Ref.get(seen)).toEqual(["connected", "disconnected"]);

          yield* SubscriptionRef.set(real, "disconnected");
          yield* awaitSeen(delivered, 2);
          yield* SubscriptionRef.set(real, "connected");
          yield* awaitSeen(delivered, 3);
          expect(yield* Ref.get(delivered)).toEqual(["connected", "disconnected", "connected"]);
          expect(yield* transport.status).toBe("disconnected");

          yield* setOffline(false);
          yield* awaitSeen(seen, 3);
          expect(yield* Ref.get(seen)).toEqual(["connected", "disconnected", "connected"]);
        })
      )
  );
});
