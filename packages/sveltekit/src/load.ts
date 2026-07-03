/**
 * Server `load` sugar
 *
 * `loadSnapshot` combines the client-group cookie with `Hydration.snapshot`:
 * resolve (or mint) the browser's group id, render the page's subsets over a
 * request-scoped engine, and return `{ snapshot, clientGroupId }` for the
 * page data. Run it inside any Effect-based server `load` (e.g.
 * `@thomasfosterau/effect-sveltekit`'s `serverLoad`) with the app's sync
 * server provided as `ServerHandler`.
 */
import type { Cookies } from "@sveltejs/kit";
import { Effect } from "effect";
import { Hydration, type Transport } from "@legation/effect";
import type {
  MutatorError,
  StoreError,
  TransportError,
  VersionNotSupportedError,
} from "@legation/effect";
import { clientGroupId, type ClientGroupOptions } from "./clientGroup.js";

/** Options for {@link loadSnapshot}. */
export interface LoadSnapshotOptions extends Omit<Hydration.SnapshotOptions, "clientGroupId"> {
  /** Client-group cookie options (name, generation, lifetime). */
  readonly cookie?: ClientGroupOptions;
}

/** What {@link loadSnapshot} returns — put both in the page data. */
export interface LoadedSnapshot {
  readonly snapshot: Hydration.Snapshot;
  readonly clientGroupId: string;
}

/**
 * Resolve the request's client group id from its cookie and produce the SSR
 * snapshot for the given subsets under it.
 */
export const loadSnapshot = (
  cookies: Cookies,
  options: LoadSnapshotOptions
): Effect.Effect<
  LoadedSnapshot,
  StoreError | TransportError | MutatorError | VersionNotSupportedError,
  Transport.ServerHandler
> =>
  Effect.suspend(() => {
    const group = clientGroupId(cookies, options.cookie);
    return Hydration.snapshot({ ...options, clientGroupId: group }).pipe(
      Effect.map((snapshot) => ({ snapshot, clientGroupId: group }))
    );
  });
