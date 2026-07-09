/**
 * @legation/devtools/react
 *
 * A thin React panel over the headless {@link Devtools.DevtoolsCore} (#120):
 * every hook here just runs the core's Effects/Streams through
 * `Effect.runFork`/`Effect.runPromise` and lands the result in React state —
 * no data acquisition of its own. A separate entry point from the package
 * root so an app that never imports `@legation/devtools/react` pays nothing
 * for it (React isn't even a dependency of the headless core).
 *
 * Visual polish is deliberately out of scope for this first cut (#120's
 * triage note): plain, legible markup, a human design pass to follow.
 */
import * as React from "react";
import { Effect, Fiber, HashMap, Stream } from "effect";
import type { MutationState, Subset } from "@legation/effect/internal";
import type * as Devtools from "./Devtools.js";

/** Subscribe to a `Stream`, re-rendering with its latest value; `initial` until the first emission. */
function useStream<A>(stream: Stream.Stream<A>, initial: A): A {
  const [value, setValue] = React.useState<A>(initial);
  React.useEffect(() => {
    const fiber = Effect.runFork(Stream.runForEach(stream, (a) => Effect.sync(() => setValue(a))));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);
  return value;
}

/**
 * Re-run a one-shot Effect snapshot whenever `signal` (a live Stream) emits,
 * plus once on mount — the pattern that gives the Introspection substrate's
 * plain-Effect reads (`subscriptions`/`cookie`/`collections`, none of which
 * are Streams) a near-live panel without inventing a bespoke wire: the
 * already-public `events` stream is the "something changed" trigger. A
 * failure falls back to `initial` — `effect`/`signal` must be referentially
 * stable across renders (a `DevtoolsCore`'s properties always are; do not
 * wrap them in a fresh `Effect.catch`/`.pipe` at the call site, or the
 * `useEffect` below re-subscribes — and re-renders — on every render).
 */
function useSnapshot<A, E, S>(
  effect: Effect.Effect<A, E>,
  signal: Stream.Stream<S>,
  initial: A
): A {
  const [value, setValue] = React.useState<A>(initial);
  React.useEffect(() => {
    const safe = Effect.catch(effect, () => Effect.succeed(initial));
    const refresh = Effect.runFork(Effect.map(safe, (a) => setValue(a)));
    const fiber = Effect.runFork(
      Stream.runForEach(signal, () => Effect.map(safe, (a) => setValue(a)))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(refresh));
      Effect.runFork(Fiber.interrupt(fiber));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effect, signal]);
  return value;
}

/** A capped rolling log of a Stream's emissions, newest last. */
function useLog<A>(stream: Stream.Stream<A>, limit: number): ReadonlyArray<A> {
  const [log, setLog] = React.useState<ReadonlyArray<A>>([]);
  React.useEffect(() => {
    setLog([]);
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (a) =>
        Effect.sync(() => setLog((prev) => [...prev, a].slice(-limit)))
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, limit]);
  return log;
}

const summariseMutation = (mutator: string, args: unknown): string => {
  try {
    return `${mutator} ${JSON.stringify(args)}`;
  } catch {
    return mutator;
  }
};

const MutationRow = (props: {
  readonly entry: MutationState.MutationState;
}): React.ReactElement => {
  const { entry } = props;
  return (
    <li>
      <strong>{entry.phase}</strong> #{entry.mutationId}{" "}
      {summariseMutation(entry.mutator, entry.args)}
      {entry.phase === "rejected" && entry.reason !== undefined ? ` — ${entry.reason}` : ""}
    </li>
  );
};

const EMPTY_STATES: MutationState.MutationStateMap = HashMap.empty();

/** Journal & mutation timeline (panel #1). */
const JournalPanel = (props: { readonly core: Devtools.DevtoolsCore }): React.ReactElement => {
  const states = useStream(props.core.mutationStates, EMPTY_STATES);
  const entries = React.useMemo(
    () => [...HashMap.values(states)].toSorted((a, b) => b.mutationId - a.mutationId),
    [states]
  );
  const pending = entries.filter((e) => e.phase === "pending").length;
  return (
    <section>
      <h3>Journal &amp; mutations</h3>
      <p>
        {pending} pending, {entries.length} total (newest first)
      </p>
      {entries.length === 0 ? (
        <p>Journal empty.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <MutationRow key={entry.mutationId} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
};

/** Subscriptions & collections (panel #2). Also used by {@link ActionsPanel}'s
 * drop-subscription list, so the panel composes it once and passes it down. */
const useSubscriptionsSnapshot = (core: Devtools.DevtoolsCore): ReadonlyArray<Subset.Subset> =>
  useSnapshot(core.subscriptions, core.events, []);

const SubscriptionsPanel = (props: {
  readonly core: Devtools.DevtoolsCore;
  readonly subscriptions: ReadonlyArray<Subset.Subset>;
}): React.ReactElement => {
  const { core, subscriptions } = props;
  const cookie = useSnapshot(core.cookie, core.events, undefined as string | undefined);
  const collections = useSnapshot(
    core.collections,
    core.events,
    [] as ReadonlyArray<Devtools.CollectionSummary>
  );
  return (
    <section>
      <h3>Subscriptions &amp; collections</h3>
      <p>Cookie: {cookie ?? "(none — no pull yet)"}</p>
      <h4>Active subscriptions</h4>
      {subscriptions.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {subscriptions.map((s, i) => (
            <li key={i}>
              {s.collection} — where {JSON.stringify(s.where)}
              {s.orderBy.length > 0 ? `, order ${JSON.stringify(s.orderBy)}` : ""}
              {s.limit !== undefined ? `, limit ${s.limit}` : ""}
            </li>
          ))}
        </ul>
      )}
      <h4>Collections</h4>
      {collections.length === 0 ? (
        <p>None synced yet.</p>
      ) : (
        <ul>
          {collections.map((c) => (
            <li key={c.name}>
              {c.name}: {c.rowCount} row{c.rowCount === 1 ? "" : "s"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** Sync activity log (panel #3). */
const ActivityPanel = (props: { readonly core: Devtools.DevtoolsCore }): React.ReactElement => {
  const events = useLog(props.core.events, 50);
  const failures = useLog(props.core.syncFailures, 10);
  const lastFailure = failures[failures.length - 1];
  return (
    <section>
      <h3>Sync activity</h3>
      <p>
        {lastFailure === undefined
          ? "No sync failures."
          : `Last failure: ${lastFailure.operation} — ${String(lastFailure.error)}`}
      </p>
      {events.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        <ul>
          {events.toReversed().map((event, i) => (
            <li key={i}>{JSON.stringify(event)}</li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** Actions (panel #4): force pull/push, simulated-offline toggle, drop a
 * subscription, and the destructive clear-store action behind a confirm. */
const ActionsPanel = (props: {
  readonly core: Devtools.DevtoolsCore;
  readonly subscriptions: ReadonlyArray<Subset.Subset>;
}): React.ReactElement => {
  const { core, subscriptions } = props;
  const [offline, setOfflineState] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    if (core.offline === undefined) return;
    const fiber = Effect.runFork(Effect.map(core.offline.isOffline, setOfflineState));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [core.offline]);

  const toggleOffline = (): void => {
    if (core.offline === undefined) return;
    const next = !(offline ?? false);
    void Effect.runPromise(core.offline.setOffline(next)).then(() => setOfflineState(next));
  };

  const clearStore = (): void => {
    if (!window.confirm("Clear every confirmed row from the store? This cannot be undone.")) return;
    void Effect.runPromise(core.clearStore);
  };

  return (
    <section>
      <h3>Actions</h3>
      <button type="button" onClick={() => void Effect.runPromise(core.forcePull)}>
        Force pull
      </button>{" "}
      <button type="button" onClick={() => void Effect.runPromise(core.forcePush)}>
        Force push
      </button>{" "}
      {core.offline === undefined ? null : (
        <button type="button" onClick={toggleOffline}>
          {offline === true ? "Go online" : "Simulate offline"}
        </button>
      )}
      <h4>Drop a subscription</h4>
      {subscriptions.length === 0 ? (
        <p>No active subscriptions.</p>
      ) : (
        <ul>
          {subscriptions.map((s, i) => (
            <li key={i}>
              {s.collection}{" "}
              <button
                type="button"
                onClick={() => void Effect.runPromise(core.dropSubscription(s))}
              >
                drop
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4>Destructive</h4>
      <button type="button" onClick={clearStore}>
        Clear store…
      </button>
    </section>
  );
};

/** The whole devtools panel: journal, subscriptions/collections, activity, actions. */
export const DevtoolsPanel = (props: {
  readonly core: Devtools.DevtoolsCore;
}): React.ReactElement => {
  const { core } = props;
  const subscriptions = useSubscriptionsSnapshot(core);
  return (
    <div>
      <h2>Devtools</h2>
      <JournalPanel core={core} />
      <SubscriptionsPanel core={core} subscriptions={subscriptions} />
      <ActivityPanel core={core} />
      <ActionsPanel core={core} subscriptions={subscriptions} />
    </div>
  );
};
