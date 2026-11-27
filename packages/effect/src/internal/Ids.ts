/**
 * Unchecked constructors for the protocol ids, for values the engine already
 * holds as one (a key it stored, a column it reads back, a watermark plus
 * one). Callers outside the engine use the schemas' `make`. This module is
 * private.
 */

import * as Brand from "effect/Brand";
import type { ClientGroupId, MutationId, RowId } from "../Protocol.js";

/** Brand a string the engine knows to be a row id. */
export const rowId: Brand.Constructor<RowId> = Brand.nominal<RowId>();

/** Brand a number the engine knows to be a mutation id. */
export const mutationId: Brand.Constructor<MutationId> = Brand.nominal<MutationId>();

/** Brand a string the engine knows to be a client group id. */
export const clientGroupId: Brand.Constructor<ClientGroupId> = Brand.nominal<ClientGroupId>();
