/**
 * An in-process effect-auth for the tests: its core services over its own
 * in-memory stores (no HTTP tier), plus a memory `ApiKeyStore` (effect-auth's
 * testing entry ships none) and stores that fail or die on demand.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import {
  type ApiKey,
  ApiKeyService,
  ApiKeyStore,
  AuthError,
  Hooks,
  RateLimiter,
  SessionService,
  SessionStore,
  UserStore,
  layerKV,
  layerMemoryKeyValueStore,
} from "@thomasfosterau/effect-auth";
import {
  fixtureUser,
  memorySessionStore,
  memoryUserStore,
  memoryUserTable,
} from "@thomasfosterau/effect-auth/testing";
import { Crash } from "./support.js";

export const alice = fixtureUser({ id: "user-alice", name: "Alice" });
export const bob = fixtureUser({ id: "user-bob", name: "Bob" });

/** A memory `ApiKeyStore` over a `MutableHashMap`. */
export const memoryApiKeyStore = (): typeof ApiKeyStore.Service => {
  const keys = MutableHashMap.empty<string, ApiKey>();
  const all = () => Array.from(MutableHashMap.values(keys));
  return {
    create: (key) => Effect.sync(() => (MutableHashMap.set(keys, key.id, key), key)),
    get: (id) => Effect.sync(() => Option.getOrNull(MutableHashMap.get(keys, id))),
    getByHash: (hash) => Effect.sync(() => all().find((key) => key.keyHash === hash) ?? null),
    update: (key) => Effect.sync(() => (MutableHashMap.set(keys, key.id, key), key)),
    delete: (id) => Effect.sync(() => void MutableHashMap.remove(keys, id)),
    listByUserId: (userId) => Effect.sync(() => all().filter((key) => key.userId === userId)),
  };
};

const sessionConfig = {
  sessionExpiresIn: {
    activePeriod: 30 * 24 * 60 * 60 * 1000,
    idlePeriod: 14 * 24 * 60 * 60 * 1000,
  },
};

/** How the stores behave: as memory stores, failing with an `AuthError` (a fault), or dying (a defect). */
export type StoreMode = "ok" | "fault" | "defect";

const broken = (mode: Exclude<StoreMode, "ok">) =>
  mode === "fault"
    ? Effect.fail(new AuthError({ message: "store unreachable" }))
    : Effect.die(new Crash({ message: "store crashed" }));

const sessionStoreFor = (mode: StoreMode): typeof SessionStore.Service => {
  const store = memorySessionStore();
  return mode === "ok" ? store : { ...store, get: () => broken(mode) };
};

const apiKeyStoreFor = (mode: StoreMode): typeof ApiKeyStore.Service => {
  const store = memoryApiKeyStore();
  return mode === "ok" ? store : { ...store, getByHash: () => broken(mode) };
};

/** effect-auth's `SessionService` and `ApiKeyService`, over fresh memory stores holding Alice and Bob. */
export const authLayer = (
  modes: { readonly sessions?: StoreMode; readonly apiKeys?: StoreMode } = {}
): Layer.Layer<SessionService | ApiKeyService> => {
  const table = memoryUserTable();
  MutableHashMap.set(table.users, alice.id, alice);
  MutableHashMap.set(table.users, bob.id, bob);
  const sessions = SessionService.layer(sessionConfig).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(UserStore, memoryUserStore(table)),
        Layer.succeed(SessionStore, sessionStoreFor(modes.sessions ?? "ok")),
        Hooks.Default
      )
    )
  );
  const apiKeys = ApiKeyService.layer().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ApiKeyStore, apiKeyStoreFor(modes.apiKeys ?? "ok")),
        RateLimiter.layer().pipe(Layer.provide(layerKV), Layer.provide(layerMemoryKeyValueStore))
      )
    )
  );
  return Layer.mergeAll(sessions, apiKeys);
};
