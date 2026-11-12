/**
 * Svelte client context
 *
 * The rune hooks reach the {@link Client.Client} — ADR-0022's one-per-thread
 * object, so where a read is answered (this thread's engine, a worker-hosted
 * one, the server) is configuration the components never see.
 *
 * An app builds a {@link ClientHandle} with {@link createClient} (#147) and
 * hands it to the component tree with {@link setClient}; the hooks read it
 * back, so they must be called during component initialisation (the same
 * rule Svelte's `getContext` follows). The runtime the hooks run over is an
 * implementation detail of the handle. An app with its own layers (an
 * in-page server, a service-worker mirror, a simulated-offline transport)
 * builds the runtime itself and wraps it with {@link fromRuntime}, or passes
 * it to {@link setClientRuntime}.
 *
 * On the server there may be no Client at all: `setClient(undefined)` renders
 * every hook from its `initial` seed, and only a hook that actually reaches
 * for the Client (a write, an unseeded read) fails, with
 * {@link ClientUnavailable}.
 */
import { createRuntimeContext } from "@thomasfosterau/effect-svelte";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { getContext, hasContext, setContext } from "svelte";
import { Client, Hydration } from "@thomasfosterau/legation";
import { HostRequest, Mirror, type MirrorChannel } from "@thomasfosterau/legation/internal";
import { unavailable } from "./unavailable.js";

export { ClientUnavailable } from "./unavailable.js";

/**
 * A runtime carrying the {@link Client.Client} — ADR-0022's one-per-thread
 * object. The rune hooks run over it: reads are declarative `Query.Read`s
 * and where they are answered (replica, host, server fallthrough) is the
 * Client's business, never the component's.
 */
export type ClientRuntime = ManagedRuntime.ManagedRuntime<Client.Client, never>;

/**
 * The Client an app hands to its component tree (#147): what {@link setClient}
 * takes, and what {@link createClient} and {@link fromRuntime} build.
 */
export interface ClientHandle {
  /** The runtime the hooks run over, for Effect code that needs the Client directly. */
  readonly runtime: ClientRuntime;
  /**
   * Release the Client: stop its sync loop and close its store and transport.
   * Call it when the app tears down (a root layout's cleanup). Calling it again
   * does nothing more.
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Options for a Client joined to an engine hosted elsewhere (#146, #147): a
 * service worker or an elected tab, reached over `channel`. `Client.connect`'s
 * options, plus the page's server-rendered snapshot to offer the host.
 */
export interface ConnectClientOptions extends Omit<Client.ConnectOptions, "channel"> {
  /**
   * The channel to the host: a channel, or the effect that opens one in the
   * Client's scope (`BroadcastMirrorChannel.make(name)` from
   * `@thomasfosterau/legation-browser`), so the app builds no scope itself.
   */
  readonly channel:
    | MirrorChannel.MirrorChannel
    | Effect.Effect<MirrorChannel.MirrorChannel, never, Scope.Scope>;
  /**
   * The page's SSR snapshot (`loadSnapshot` on the server), offered to the
   * host before anything is subscribed: the host hydrates its durable store
   * with it only when that store is empty and has not pulled, so a returning
   * visitor's rows, cookie and journalled mutations are never touched. Render
   * from it meanwhile by seeding the hooks
   * (`initial: Hydration.rowsFor(snapshot, nodes, read)`); a `false` answer
   * needs no action.
   */
  readonly snapshot?: Hydration.Snapshot | undefined;
  /**
   * How long to keep offering the snapshot while no host answers (a service
   * worker still installing, say): the offer is re-sent every half second
   * until an answer arrives or this elapses. Defaults to 5 seconds. The
   * Client is not handed to the hooks until then, so they render from their
   * seeds meanwhile.
   */
  readonly hydrateTimeout?: Duration.Input | undefined;
  /** Reads to pin for the Client's lifetime (the app shell's working set), made once the snapshot is settled. */
  readonly subscribe?: ReadonlyArray<Parameters<Client.Client["subscribe"]>[0]> | undefined;
}

/** A {@link ClientHandle} over a hosted engine, with the host's answer to the snapshot. */
export interface ConnectedClientHandle extends ClientHandle {
  /**
   * The host's answer to the snapshot, once the Client is built (on first
   * use): `Some` with whether it hydrated (and why not), or `None` when there
   * was no snapshot, no host answered within `hydrateTimeout`, the host does
   * not serve hydration, or the handle was disposed first. Observational: no
   * outcome needs any action from the app.
   */
  readonly hydration: Promise<Option.Option<Hydration.HydrateOutcome>>;
}

/** The hydration settler before the promise has handed over its own. */
const unsettled = (_outcome: Option.Option<Hydration.HydrateOutcome>): void => {};

/** How long one offer of the snapshot waits for an answer before it is re-sent. */
const OFFER_ATTEMPT = Duration.millis(500);

/**
 * Offer the snapshot to the host until it answers, `Unanswered` offers re-sent
 * (a host that is not up yet drops them), for at most `timeout`. Any other
 * failure, or no answer, is `None`, logged.
 */
const offerSnapshot = (
  mirror: Mirror.Mirror,
  snapshot: Hydration.Snapshot,
  timeout: Duration.Input
): Effect.Effect<Option.Option<Hydration.HydrateOutcome>> =>
  mirror.request(Hydration.requests.hydrate, snapshot).pipe(
    Effect.timeoutOption(OFFER_ATTEMPT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(HostRequest.unanswered("hydrate", "No answer to this offer of the snapshot")),
        onSome: (outcome) => Effect.succeed(outcome),
      })
    ),
    Effect.retry({ while: (error) => error.reason === "Unanswered" }),
    Effect.timeoutOption(timeout),
    Effect.catch((error) =>
      Effect.logWarning("legation-svelte: the engine host did not take the snapshot", {
        error,
      }).pipe(Effect.as(Option.none<Hydration.HydrateOutcome>()))
    )
  );

/** The connected Client's runtime: mirror → snapshot offered → Client → shell pins. */
const connectRuntime = (
  options: ConnectClientOptions,
  settle: (outcome: Option.Option<Hydration.HydrateOutcome>) => void
): ClientRuntime => {
  const { snapshot, hydrateTimeout, subscribe, ...connect } = options;
  return ManagedRuntime.make(
    Layer.effect(Client.Client)(
      Effect.gen(function* () {
        const channel = Effect.isEffect(connect.channel) ? yield* connect.channel : connect.channel;
        const mirror = yield* Mirror.make({ channel, mutators: connect.mutations });
        // The offer goes before anything subscribes: a registration makes the
        // host pull, and a pull that has started turns the snapshot away.
        const outcome =
          snapshot === undefined
            ? Option.none<Hydration.HydrateOutcome>()
            : yield* offerSnapshot(mirror, snapshot, hydrateTimeout ?? Duration.seconds(5));
        settle(outcome);
        const client = Client.fromView(
          connect.nodes,
          mirror,
          connect.urls === undefined ? {} : { urls: connect.urls }
        );
        if (subscribe !== undefined) {
          yield* Effect.forEach(subscribe, (read) => client.subscribe(read), {
            concurrency: 1,
            discard: true,
          }).pipe(Effect.orDie);
        }
        return client;
      })
    )
  );
};

/**
 * Build the Client a Svelte app boots with (#147): `Client.make`'s options in,
 * a {@link ClientHandle} out, with no Effect runtime for the app to build. The
 * Client is built on first use, so creating the handle does no work; with
 * `transport: { url }` it is the standard remote setup.
 *
 * Given a `channel` instead ({@link ConnectClientOptions}), the Client joins
 * an engine hosted elsewhere (a service worker, an elected tab), and a
 * `snapshot` is offered to that host's store first (#146): the host owns the
 * empty-store gate, and the handle's `hydration` reports its answer.
 */
export function createClient(options: ConnectClientOptions): ConnectedClientHandle;
/** The owned form: the Client builds its own engine (`Client.make`). */
export function createClient(options: Client.MakeOptions): ClientHandle;
export function createClient(
  options: Client.MakeOptions | ConnectClientOptions
): ClientHandle | ConnectedClientHandle {
  if (!("channel" in options)) {
    return fromRuntime(
      ManagedRuntime.make(
        Layer.effect(Client.Client)(Effect.map(Client.make(options), (made) => made.client))
      )
    );
  }
  let settle: (outcome: Option.Option<Hydration.HydrateOutcome>) => void = unsettled;
  const hydration = new Promise<Option.Option<Hydration.HydrateOutcome>>((resolve) => {
    settle = resolve;
  });
  const runtime = connectRuntime(options, (outcome) => settle(outcome));
  return {
    runtime,
    hydration,
    dispose: () => {
      settle(Option.none());
      return runtime.dispose();
    },
  };
}

/**
 * Wrap a runtime the app built itself, for the custom-layer path: an in-page
 * server, a service-worker mirror, a simulated-offline transport.
 */
export const fromRuntime = (runtime: ClientRuntime): ClientHandle => ({
  runtime,
  dispose: () => runtime.dispose(),
});

const clientContext = createRuntimeContext<Client.Client>(
  "@thomasfosterau/legation-svelte — call setClient(createClient(…)) higher in the component tree"
);

const handleKey = Symbol.for("@thomasfosterau/legation-svelte/ClientHandle");

/**
 * The runtime a tree with no Client runs its hooks over. Building it is lazy,
 * so it costs nothing until a hook reaches for the Client, and then it fails.
 */
const unavailableRuntime: ClientRuntime = /* @__PURE__ */ ManagedRuntime.make(
  Layer.effect(Client.Client)(Effect.die(unavailable()))
);

/**
 * Provide the Client to descendant components. Call once, high in the tree,
 * before any rune hook. `undefined` (on the server, say) renders every hook
 * from its `initial` seed; a hook that needs the Client then fails with
 * {@link ClientUnavailable}.
 */
export const setClient = (client?: ClientHandle): void => {
  setContext(handleKey, Option.fromUndefinedOr(client));
  clientContext.provide(client === undefined ? unavailableRuntime : client.runtime);
};

/** The Client put in context by {@link setClient}: `None` when it was given none. */
export const getClient = (): Option.Option<ClientHandle> =>
  hasContext(handleKey) ? getContext<Option.Option<ClientHandle>>(handleKey) : Option.none();

/**
 * Provide a Client runtime the app built itself: the escape hatch beside
 * {@link setClient}, the same as `setClient(fromRuntime(runtime))`.
 */
export const setClientRuntime = (runtime: ClientRuntime): void => {
  setClient(fromRuntime(runtime));
};

/** Read the Client runtime put in context by {@link setClient} or {@link setClientRuntime}. */
export const getClientRuntime = (): ClientRuntime =>
  // Narrowing as in {@link getEngineRuntime}: `setClient` is the only writer.
  clientContext.get() as ClientRuntime;
