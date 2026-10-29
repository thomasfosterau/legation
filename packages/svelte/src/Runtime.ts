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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { getContext, hasContext, setContext } from "svelte";
import { Client } from "@thomasfosterau/legation-effect";
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
 * Build the Client a Svelte app boots with (#147): `Client.make`'s options in,
 * a {@link ClientHandle} out, with no Effect runtime for the app to build. The
 * Client is built on first use, so creating the handle does no work; with
 * `transport: { url }` it is the standard remote setup.
 */
export const createClient = (options: Client.MakeOptions): ClientHandle =>
  fromRuntime(
    ManagedRuntime.make(
      Layer.effect(Client.Client)(Effect.map(Client.make(options), (made) => made.client))
    )
  );

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
