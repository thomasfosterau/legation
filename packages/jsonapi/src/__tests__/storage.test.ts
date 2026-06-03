import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeInMemoryStorage } from "../storage.js";
import type { ResourceObject } from "../types.js";

describe("InMemoryStorage", () => {
  it.effect("should store and retrieve a resource", () =>
    Effect.gen(function* () {
      const storage = makeInMemoryStorage();

      const resource: ResourceObject = {
        type: "users",
        id: "1",
        attributes: {
          name: "John Doe",
        },
      };

      yield* storage.set(resource);

      const retrieved = yield* storage.get("users", "1");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("1");
      expect(retrieved?.attributes?.name).toBe("John Doe");
    })
  );

  it.effect("should return null for non-existent resources", () =>
    Effect.gen(function* () {
      const storage = makeInMemoryStorage();

      const retrieved = yield* storage.get("users", "999");

      expect(retrieved).toBeNull();
    })
  );

  it.effect("should delete a resource", () =>
    Effect.gen(function* () {
      const storage = makeInMemoryStorage();

      const resource: ResourceObject = {
        type: "users",
        id: "1",
        attributes: {
          name: "John Doe",
        },
      };

      yield* storage.set(resource);
      yield* storage.delete("users", "1");

      const retrieved = yield* storage.get("users", "1");

      expect(retrieved).toBeNull();
    })
  );

  it.effect("should list resources of a specific type", () =>
    Effect.gen(function* () {
      const storage = makeInMemoryStorage();

      const user1: ResourceObject = {
        type: "users",
        id: "1",
        attributes: { name: "John" },
      };

      const user2: ResourceObject = {
        type: "users",
        id: "2",
        attributes: { name: "Jane" },
      };

      const article: ResourceObject = {
        type: "articles",
        id: "1",
        attributes: { title: "Test" },
      };

      yield* storage.set(user1);
      yield* storage.set(user2);
      yield* storage.set(article);

      const users = yield* storage.list("users");

      expect(users).toHaveLength(2);
      expect(users.every((u) => u.type === "users")).toBe(true);
    })
  );
});
