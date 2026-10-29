/**
 * PushPoke
 *
 * Web Push as a poke carrier (#214): the one mechanism that wakes a service
 * worker that is not running, so a client with no open tab converges before
 * the user returns. Under poke-then-pull it is a safe fit. A poke carries no
 * data, so a lost push costs a delay and a duplicate costs one pull that finds
 * nothing: pull is the correctness path (ADR-0008).
 *
 * ## The payload is contentless
 *
 * Every push this module sends is {@link payload}: a fixed marker and nothing
 * else. No topic, no collection name, no row id. A push payload crosses a
 * third-party push service, and a collection name would tell it what a user
 * subscribes to. The pull the poke prompts is the authenticated channel; that
 * is where the data travels.
 *
 * ## The app owns the subscriptions and the credentials
 *
 * {@link sink} takes the app's endpoint registry (which subscriptions a change
 * should wake, {@link SinkOptions.targetsFor}) and the app's sender
 * ({@link SinkOptions.send}, which signs with the app's VAPID keys). The
 * library holds no credential and stores no subscription.
 *
 * ## The budget is the app's stated choice
 *
 * Browsers penalise a push that shows no notification, and push services
 * rate-limit each subscription: an app that wakes a device for every write can
 * lose its push permission. So {@link SinkOptions.coalesce} and
 * {@link SinkOptions.budget} are required, with no default: the silent-push
 * posture is a decision the app writes down, not a guess the library makes.
 * Within the coalescing window a target gets at most one push, plus one more at
 * the window's end if anything else changed meanwhile; past its budget a
 * target gets none until the budget period moves on. A skipped push is logged
 * at debug level: the next pull, or the next page boot, converges anyway.
 *
 * The worker side, which turns a recognised push into a Background Sync
 * registration or a pull, is `PushPoke` in `@thomasfosterau/legation-browser`.
 */

import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Clock from "effect/Clock";
import type { Touched } from "./HttpCache.js";
import type { InvalidationSink } from "./InvalidationSink.js";

/**
 * The payload of every push-poke: a fixed marker, so the worker can tell the
 * library's push from the app's own, and nothing about what changed.
 */
export const payload = '{"legation":"poke"}';

/** Whether a push's text is the library's poke ({@link payload}). */
export const isPoke = (text: string): boolean => text === payload;

/** How many push-pokes a target may receive per period. */
export interface Budget {
  readonly pushes: number;
  readonly per: Duration.Input;
}

/** Options for {@link sink}. `Target` is the app's own push subscription record. */
export interface SinkOptions<Target> {
  /**
   * The push subscriptions a change should wake: the app's endpoint registry,
   * scoped as the app scopes its users' data (a write to a user's rows wakes
   * that user's devices). Failing reads as no targets, logged.
   */
  readonly targetsFor: (touched: Touched) => Effect.Effect<ReadonlyArray<Target>, unknown>;
  /** A stable key per target, for coalescing and the budget: its endpoint URL, say. */
  readonly keyOf: (target: Target) => string;
  /**
   * Send `payload` to `target` through its push service, signed with the
   * app's VAPID keys. A failure is logged, never retried here: the next change
   * pokes again, and pull converges regardless.
   */
  readonly send: (target: Target, payload: string) => Effect.Effect<void, unknown>;
  /** **Required.** At most one push per target per window, plus one trailing push. */
  readonly coalesce: Duration.Input;
  /** **Required.** The most pushes a target receives per period; past it, none. */
  readonly budget: Budget;
}

interface TargetState {
  /** When the last push to the target went out. */
  readonly lastSent: number;
  /** Whether a trailing push is scheduled for the end of the window. */
  readonly trailing: boolean;
  /** When each push inside the current budget period went out. */
  readonly sent: ReadonlyArray<number>;
}

const emptyState: TargetState = { lastSent: Number.NEGATIVE_INFINITY, trailing: false, sent: [] };

/** What to do with one target's push now. */
type Decision = "send" | "trail" | "skip" | "over-budget";

/**
 * An `InvalidationSink` that pokes the devices a change should wake, over Web
 * Push, within the app's coalescing window and budget. Run it with
 * `InvalidationSink.run` where the bus is. Its trailing pushes run on fibres
 * of the scope it is built in.
 */
export const sink = <Target>(
  options: SinkOptions<Target>
): Effect.Effect<InvalidationSink, never, Scope.Scope> =>
  Effect.gen(function* () {
    const window = Duration.toMillis(Duration.fromInputUnsafe(options.coalesce));
    const period = Duration.toMillis(Duration.fromInputUnsafe(options.budget.per));
    const limit = Math.max(0, options.budget.pushes);
    const states = yield* Ref.make(HashMap.empty<string, TargetState>());
    const scope = yield* Effect.scope;

    const stateOf = (all: HashMap.HashMap<string, TargetState>, key: string): TargetState =>
      Option.getOrElse(HashMap.get(all, key), () => emptyState);

    // Record a push to `key` at `now`, if the budget allows it.
    const claim = (key: string, now: number) =>
      Ref.modify(states, (all): readonly [boolean, HashMap.HashMap<string, TargetState>] => {
        const state = stateOf(all, key);
        const sent = state.sent.filter((at) => now - at < period);
        if (sent.length >= limit) return [false, all];
        return [
          true,
          HashMap.set(all, key, { lastSent: now, trailing: false, sent: [...sent, now] }),
        ];
      });

    const push = (target: Target, key: string, now: number): Effect.Effect<void> =>
      Effect.flatMap(claim(key, now), (allowed) =>
        allowed
          ? options
              .send(target, payload)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("PushPoke: a push failed; the next pull converges", cause)
                )
              )
          : Effect.logDebug("PushPoke: a target is over its push budget; skipped")
      );

    // Decide one target's push: send now, schedule the trailing push, or skip.
    const decide = (key: string, now: number) =>
      Ref.modify(states, (all): readonly [Decision, HashMap.HashMap<string, TargetState>] => {
        const state = stateOf(all, key);
        if (now - state.lastSent >= window) return ["send", all];
        if (state.trailing) return ["skip", all];
        return ["trail", HashMap.set(all, key, { ...state, trailing: true })];
      });

    const poke = (target: Target): Effect.Effect<void> =>
      Effect.gen(function* () {
        const key = options.keyOf(target);
        const now = yield* Clock.currentTimeMillis;
        const decision = yield* decide(key, now);
        if (decision === "send") return yield* push(target, key, now);
        if (decision !== "trail") return;
        const state = stateOf(yield* Ref.get(states), key);
        const wait = Math.max(0, state.lastSent + window - now);
        yield* Effect.forkIn(
          Effect.sleep(Duration.millis(wait)).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((at) => push(target, key, at))
          ),
          scope
        );
      });

    return {
      invalidate: (touched) =>
        options.targetsFor(touched).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("PushPoke: the endpoint registry failed; no push sent", cause).pipe(
              Effect.as(Arr.empty<Target>())
            )
          ),
          Effect.flatMap((targets) =>
            Effect.forEach(
              Arr.dedupeWith(targets, (a, b) => options.keyOf(a) === options.keyOf(b)),
              poke,
              {
                concurrency: "unbounded",
                discard: true,
              }
            )
          )
        ),
    };
  });
