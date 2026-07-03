import type { DatabaseSync } from "node:sqlite";
import type { Transport } from "@legation/effect";

declare global {
  namespace App {
    interface Locals {
      db: DatabaseSync;
      handler: Transport.ServerHandler;
    }
  }
}

export {};
