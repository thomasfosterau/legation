/**
 * Fetch-based HTTP Client Implementation
 * 
 * A simple HTTP client implementation using the Fetch API
 */

import { Effect } from "effect";
import type { JsonApiDocument, JsonApiRequestOptions } from "./types";
import { NetworkError } from "./errors";
import type { HttpClient } from "./synchronizer";

/**
 * Build query string from JSON:API request options
 */
const buildQueryString = (options?: JsonApiRequestOptions): string => {
  if (!options) return "";

  const params = new URLSearchParams();

  if (options.include) {
    params.append("include", options.include.join(","));
  }

  if (options.fields) {
    for (const [type, fields] of Object.entries(options.fields)) {
      params.append(`fields[${type}]`, fields.join(","));
    }
  }

  if (options.sort) {
    params.append("sort", options.sort.join(","));
  }

  if (options.filter) {
    for (const [key, value] of Object.entries(options.filter)) {
      params.append(`filter[${key}]`, value);
    }
  }

  if (options.page) {
    for (const [key, value] of Object.entries(options.page)) {
      if (value !== undefined) {
        params.append(`page[${key}]`, value.toString());
      }
    }
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
};

/**
 * Create a fetch-based HTTP client implementation
 */
export const makeFetchHttpClient = (): HttpClient => {
  const headers = {
    "Content-Type": "application/vnd.api+json",
    Accept: "application/vnd.api+json",
  };

  return {
    get: (url: string, options?: JsonApiRequestOptions) =>
      Effect.tryPromise({
        try: () =>
          fetch(`${url}${buildQueryString(options)}`, {
            method: "GET",
            headers,
          }),
        catch: (error) =>
          new NetworkError("GET request failed", error),
      }),

    post: (url: string, body: JsonApiDocument) =>
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          }),
        catch: (error) =>
          new NetworkError("POST request failed", error),
      }),

    patch: (url: string, body: JsonApiDocument) =>
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "PATCH",
            headers,
            body: JSON.stringify(body),
          }),
        catch: (error) =>
          new NetworkError("PATCH request failed", error),
      }),

    delete: (url: string) =>
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "DELETE",
            headers,
          }),
        catch: (error) =>
          new NetworkError("DELETE request failed", error),
      }),
  };
};
