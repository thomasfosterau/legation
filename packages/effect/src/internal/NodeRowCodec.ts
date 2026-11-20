/**
 * NodeRowCodec
 *
 * A node's row schema as the service-free codec `Collection.make` takes. This
 * module is private. `effect/avoid-any` and `effect/no-chained-type-assertions`
 * are off for this module alone, in the root `vite.config.ts`.
 */

import type * as Schema from "effect/Schema";
import type { AnyNode } from "../Node.js";

/**
 * The node's row codec, asserted service-free. `AnyNode` erases its fields to
 * the open `Schema.Struct.Fields`, whose decoding services are `unknown`.
 * Narrowing `AnyNode` to service-free fields would state this without the
 * assertion, but `NodeBridge` builds nodes from effect-jsonapi's
 * `Resource.Any`, whose attribute fields are open too, so a bridged node is
 * not service-free by its type. The fix needs a service-free `Resource.Any`
 * in effect-jsonapi.
 */
export const rowCodec = (node: AnyNode): Schema.Codec<unknown, unknown> =>
  // SAFETY: only the erased type says the row's services are `unknown` (see
  // above); the row codec itself is passed on unchanged.
  node.row as unknown as Schema.Codec<unknown, unknown>;
