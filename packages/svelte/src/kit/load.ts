/**
 * Server `load` sugar
 *
 * `loadSnapshot` combines the client-group cookie with `Hydration.snapshot`:
 * resolve (or mint) the browser's group id, render the page's subsets over a
 * request-scoped engine, and return `{ snapshot, clientGroupId }` for the
 * page data. Run it inside any Effect-based server `load` (e.g.
 * `@thomasfosterau/effect-sveltekit`'s `serverLoad`). The snapshot itself is
 * core (`Hydration.snapshot`); this only folds the cookie into it.
 *
 * Where the backend lives decides what the `load` supplies. Same process:
 * provide the app's sync server as `ServerHandler` and pass no transport.
 * Separate Worker (the usual Cloudflare shape — a SvelteKit Worker in front
 * of a binding-only API Worker): pass a `transport` built from the request's
 * service binding (`BindingTransport` in `@legation/cloudflare`), and nothing
 * is required from context.
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

/** {@link LoadSnapshotOptions} with the carrier supplied — no `ServerHandler` needed. */
export interface RemoteLoadSnapshotOptions extends LoadSnapshotOptions {
  readonly transport: Transport.ClientTransport;
}

/** What {@link loadSnapshot} returns — put both in the page data. */
export interface LoadedSnapshot {
  readonly snapshot: Hydration.Snapshot;
  readonly clientGroupId: string;
}

type LoadSnapshotError = StoreError | TransportError | MutatorError | VersionNotSupportedError;

/**
 * Resolve the request's client group id from its cookie and produce the SSR
 * snapshot for the given subsets under it.
 *
 * The group id is the point of the cookie: the render happens under the
 * *browser's* group, so the snapshot's pull cookie continues that group's CVR
 * conversation. That holds over a remote `transport` too — the id travels on
 * the pull request and the server's fresh cookie travels back.
 */
export function loadSnapshot(
  cookies: Cookies,
  options: RemoteLoadSnapshotOptions
): Effect.Effect<LoadedSnapshot, LoadSnapshotError>;
/** The in-process form: renders against the app's sync server, the `ServerHandler` in context. */
export function loadSnapshot(
  cookies: Cookies,
  options: LoadSnapshotOptions
): Effect.Effect<LoadedSnapshot, LoadSnapshotError, Transport.ServerHandler>;
export function loadSnapshot(
  cookies: Cookies,
  options: LoadSnapshotOptions
): Effect.Effect<LoadedSnapshot, LoadSnapshotError, Transport.ServerHandler> {
  return Effect.suspend(() => {
    const group = clientGroupId(cookies, options.cookie);
    return Hydration.snapshot({ ...options, clientGroupId: group }).pipe(
      Effect.map((snapshot) => ({ snapshot, clientGroupId: group }))
    );
  });
}
