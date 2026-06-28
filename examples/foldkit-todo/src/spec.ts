/**
 * API spec
 *
 * This example's sync surface, projected to OpenAPI 3.1 + AsyncAPI 3.0 so a
 * bespoke client can be generated in any language (ADR-0017). The same domain
 * definitions that drive the engine drive the spec, so it cannot drift. Run
 * `bun run spec` to write the documents into `spec/`.
 */
import { SpecExport } from "@thomasfosterau/effect-sync-core";
import { removeTodo, setTodo, todosCollection } from "./domain";

export const api: SpecExport.SyncApi = {
  info: { title: "Effect Sync — Foldkit Todo", version: "1.0.0" },
  collections: [todosCollection],
  mutators: [setTodo, removeTodo],
};

export const openapi = SpecExport.openApi(api);
export const asyncapi = SpecExport.asyncApi(api);
