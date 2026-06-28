/**
 * gen-example-spec
 *
 * Shared generator behind every example's `spec` script. It imports the
 * example's pure `src/spec.ts` — its OpenAPI 3.1 + AsyncAPI 3.0 projection of
 * its sync surface (ADR-0017) — and writes the documents to `spec/`. Run from
 * an example directory via `bun run spec`.
 *
 * The spec is a derived projection of the same domain definitions that drive
 * the engine, so the output is regenerated, never hand-edited (and is
 * git-ignored to avoid drift).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const dir = process.cwd();
const { openapi, asyncapi } = await import(resolve(dir, "src/spec.ts"));

const out = join(dir, "spec");
await mkdir(out, { recursive: true });
await writeFile(join(out, "openapi.json"), `${JSON.stringify(openapi, null, 2)}\n`);
await writeFile(join(out, "asyncapi.json"), `${JSON.stringify(asyncapi, null, 2)}\n`);

console.log(`Wrote ${join(out, "openapi.json")}`);
console.log(`Wrote ${join(out, "asyncapi.json")}`);
