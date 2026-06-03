/**
 * In-Memory Storage Implementation
 *
 * A simple in-memory storage implementation for testing and development
 */

import { Effect } from "effect";
import type { ResourceObject } from "./types.js";
import type { Storage } from "./synchronizer.js";

const makeKey = (type: string, id: string): string => `${type}:${id}`;

/**
 * Create an in-memory storage implementation
 */
export const makeInMemoryStorage = (): Storage => {
  const store = new Map<string, ResourceObject>();

  return {
    get: (type: string, id: string) =>
      Effect.sync(() => {
        const key = makeKey(type, id);
        return store.get(key) ?? null;
      }),

    set: (resource: ResourceObject) =>
      Effect.sync(() => {
        const key = makeKey(resource.type, resource.id);
        store.set(key, resource);
      }),

    delete: (type: string, id: string) =>
      Effect.sync(() => {
        const key = makeKey(type, id);
        store.delete(key);
      }),

    list: (type: string) =>
      Effect.sync(() => {
        const resources: ResourceObject[] = [];
        for (const [key, resource] of store.entries()) {
          if (key.startsWith(`${type}:`)) {
            resources.push(resource);
          }
        }
        return resources;
      }),
  };
};
