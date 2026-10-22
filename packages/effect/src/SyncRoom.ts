/**
 * SyncRoom
 *
 * The packaged server composition (ADR-0009): SyncServer orchestration +
 * in-memory CVR store + in-process invalidation bus, ready to bind to any
 * carrier. The same composition runs in-process on Node or inside a
 * Cloudflare Durable Object (where the DO's single-threaded scope IS the
 * room); distributed deployments swap the bus and CVR store layers.
 */

import * as Layer from "effect/Layer";
import type { Backend } from "./Backend.js";
import type { AuthPolicy } from "./Authorization.js";
import * as Cvr from "./Cvr.js";
import * as InvalidationBus from "./InvalidationBus.js";
import * as SyncServer from "./SyncServer.js";
import type { ServerHandler } from "./Transport.js";

/**
 * A self-contained room: provide a Backend and an AuthPolicy, get a
 * ServerHandler. CVRs and the bus are in-memory/in-process.
 */
export const layer: Layer.Layer<ServerHandler, never, Backend | AuthPolicy> = SyncServer.layer.pipe(
  Layer.provide(Cvr.layerMemoryStore),
  Layer.provide(InvalidationBus.layerInProcess)
);
