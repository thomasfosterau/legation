/**
 * JsonApiWire
 *
 * The JSON:API wire shapes `DocumentWriter` serialises as is, where JSON:API
 * spells "nothing" `data: null`. This module is private: `DocumentWriter`
 * builds its public types from these. `effect/prefer-option-over-null` is off
 * for this module alone, in the root `vite.config.ts`.
 */

import type { Handlers } from "@thomasfosterau/effect-jsonapi";

/**
 * A relationship object's inline linkage: one identifier, a list of them, or
 * `null`, JSON:API's empty to-one resource linkage.
 */
export interface Linkage<Identifier> {
  readonly data: Identifier | ReadonlyArray<Identifier> | null;
}

/**
 * A single-resource document, `{ data: resource | null, included?, links }`.
 * JSON:API answers a single-resource read that matched nothing with
 * `data: null`, as effect-jsonapi's `Handlers.data` does.
 */
export type SingleResourceDocument<Resource> = Handlers.DocumentValue<Resource | null, Resource>;
