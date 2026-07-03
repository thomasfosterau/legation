import type { Transport } from "@legation/effect";
import type { CommerceApi } from "../server/client.js";

declare global {
  namespace App {
    interface Locals {
      /** In-process sync handler for SSR snapshot loads. */
      handler: Transport.ServerHandler;
      /** Typed client for the sync server's /api write surface. */
      api: CommerceApi;
      /** Resolve the signed-in user bound to a browser's client group. */
      userFor: (clientGroupId: string) => Promise<string | undefined>;
    }
  }
}

export {};
