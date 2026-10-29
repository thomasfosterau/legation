/**
 * The failure of a hook that reaches for a Client where none was set (#147):
 * `setClient(undefined)`, as on the server. Kept apart from `Runtime.ts` so the
 * hooks can raise it without importing the context module's public surface.
 */
import * as Schema from "effect/Schema";

/**
 * A hook reached for the Client where none was set: `setClient(undefined)`,
 * as on the server, where a hook renders from its `initial` seed and fails
 * only when it needs the Client itself.
 */
export class ClientUnavailable extends Schema.TaggedError<ClientUnavailable>()(
  "ClientUnavailable",
  { message: Schema.String }
) {}

/** The {@link ClientUnavailable} a hook fails with when no Client was set. */
export const unavailable = (): ClientUnavailable =>
  new ClientUnavailable({
    message:
      "@thomasfosterau/legation-svelte: no Client here (setClient was given none, as on the server). A hook renders from its `initial` seed without one; this one needed the Client.",
  });
