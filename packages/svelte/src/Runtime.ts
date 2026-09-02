/**
 * Svelte runtime context
 *
 * The rune hooks run their effects through a `ManagedRuntime` that provides
 * the {@link Client.Client} — ADR-0022's one-per-thread object, so where a
 * read is answered (this thread's engine, a worker-hosted one, the server) is
 * configuration the components never see. The app builds the runtime and hands
 * it to the component tree via {@link setClientRuntime}; the hooks read it back
 * with {@link getClientRuntime}, so they must be called during component
 * initialisation (the same rule Svelte's `getContext` follows).
 */
import { createRuntimeContext } from "@thomasfosterau/effect-svelte";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type { Client } from "@legation/effect";

/**
 * A runtime carrying the {@link Client.Client} — ADR-0022's one-per-thread
 * object. The rune hooks run over it: reads are declarative `Query.Read`s
 * and where they are answered (replica, host, server fallthrough) is the
 * Client's business, never the component's.
 */
export type ClientRuntime = ManagedRuntime.ManagedRuntime<Client.Client, never>;

const clientContext = createRuntimeContext<Client.Client>(
  "@legation/svelte — call setClientRuntime(runtime) higher in the component tree"
);

/**
 * Provide the Client runtime to descendant components. Call once, high in
 * the tree, before any rune hook.
 */
export const setClientRuntime = (runtime: ClientRuntime): void => {
  clientContext.provide(runtime);
};

/** Read the Client runtime put in context by {@link setClientRuntime}. */
export const getClientRuntime = (): ClientRuntime =>
  // Narrowing as in {@link getEngineRuntime}: `setClientRuntime` is the
  // only writer.
  clientContext.get() as ClientRuntime;
