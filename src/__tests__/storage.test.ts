import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeInMemoryStorage } from "../storage";
import type { ResourceObject } from "../types";

describe("InMemoryStorage", () => {
  it("should store and retrieve a resource", async () => {
    const storage = makeInMemoryStorage();

    const resource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "John Doe",
      },
    };

    await Effect.runPromise(storage.set(resource));

    const retrieved = await Effect.runPromise(storage.get("users", "1"));

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("1");
    expect(retrieved?.attributes?.name).toBe("John Doe");
  });

  it("should return null for non-existent resources", async () => {
    const storage = makeInMemoryStorage();

    const retrieved = await Effect.runPromise(storage.get("users", "999"));

    expect(retrieved).toBeNull();
  });

  it("should delete a resource", async () => {
    const storage = makeInMemoryStorage();

    const resource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "John Doe",
      },
    };

    await Effect.runPromise(storage.set(resource));
    await Effect.runPromise(storage.delete("users", "1"));

    const retrieved = await Effect.runPromise(storage.get("users", "1"));

    expect(retrieved).toBeNull();
  });

  it("should list resources of a specific type", async () => {
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

    await Effect.runPromise(storage.set(user1));
    await Effect.runPromise(storage.set(user2));
    await Effect.runPromise(storage.set(article));

    const users = await Effect.runPromise(storage.list("users"));

    expect(users).toHaveLength(2);
    expect(users.every((u) => u.type === "users")).toBe(true);
  });
});
