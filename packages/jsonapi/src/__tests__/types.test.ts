import { describe, it, expect } from "vitest";
import type { JsonApiDocument, ResourceObject, JsonApiError } from "../types.js";

describe("JSON:API Types", () => {
  it("should create a valid resource object", () => {
    const resource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "John Doe",
        email: "john@example.com",
      },
    };

    expect(resource.type).toBe("users");
    expect(resource.id).toBe("1");
    expect(resource.attributes?.name).toBe("John Doe");
  });

  it("should create a resource with relationships", () => {
    const resource: ResourceObject = {
      type: "articles",
      id: "1",
      attributes: {
        title: "Test Article",
      },
      relationships: {
        author: {
          data: { type: "users", id: "1" },
        },
      },
    };

    expect(resource.relationships?.author.data).toEqual({
      type: "users",
      id: "1",
    });
  });

  it("should create a valid JSON:API document", () => {
    const document: JsonApiDocument = {
      data: {
        type: "users",
        id: "1",
        attributes: {
          name: "John Doe",
        },
      },
      meta: {
        version: "1.0",
      },
    };

    expect(document.data).toBeDefined();
    expect(document.meta?.version).toBe("1.0");
  });

  it("should create a document with errors", () => {
    const error: JsonApiError = {
      status: "400",
      title: "Invalid Request",
      detail: "The request body is invalid",
    };

    const document: JsonApiDocument = {
      errors: [error],
    };

    expect(document.errors).toHaveLength(1);
    expect(document.errors?.[0].status).toBe("400");
  });

  it("should create a document with included resources", () => {
    const document: JsonApiDocument = {
      data: {
        type: "articles",
        id: "1",
        attributes: {
          title: "Test Article",
        },
        relationships: {
          author: {
            data: { type: "users", id: "1" },
          },
        },
      },
      included: [
        {
          type: "users",
          id: "1",
          attributes: {
            name: "John Doe",
          },
        },
      ],
    };

    expect(document.included).toHaveLength(1);
    expect(document.included?.[0].type).toBe("users");
  });
});
