/**
 * WireFlags
 *
 * The boolean schema fields whose names a published wire fixes, so they keep
 * their names instead of an `is`/`has`/`was` prefix. Each is a one-field
 * struct that its message schema spreads in (`...WireFlags.Pulled.fields`).
 * This module is private. `effect/require-is-prefix-for-boolean-schema-field`
 * is off for this module alone, in the root `vite.config.ts`.
 */

import * as Schema from "effect/Schema";

/**
 * `hydrated`: the answer to the `hydrate` host-request kind
 * (`Hydration.HydrateOutcome`), whose wire contract names it (ADR-0021
 * amendment §6). Wire schemas describe the wire literally (owner decision,
 * #562), so it is not renamed over the same wire with `Schema.encodeKeys`.
 */
export const Hydrated = Schema.Struct({ hydrated: Schema.Boolean });

/** The type {@link Hydrated} decodes to. */
export type Hydrated = typeof Hydrated.Type;

/**
 * `pulled`: a coverage window on the mirror protocol's `PulledRegistrations`
 * message (`MirrorProtocol`), the wire form of `Coverage.Window.pulled`. The
 * host posts mirror messages as their decoded value (a structured clone, no
 * schema encode), so this schema's type is the wire itself.
 */
export const Pulled = Schema.Struct({ pulled: Schema.Boolean });

/** The type {@link Pulled} decodes to. */
export type Pulled = typeof Pulled.Type;
