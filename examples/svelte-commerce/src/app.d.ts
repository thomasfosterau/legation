import type { CommerceApi } from "../server/client.js";

declare global {
  namespace App {
    interface Locals {
      /** The Better Auth session user, when signed in. */
      user: { id: string; name: string; email: string } | undefined;
      /** JSON:API client acting as the session user (or anonymously). */
      api: CommerceApi;
    }
  }
}

export {};
