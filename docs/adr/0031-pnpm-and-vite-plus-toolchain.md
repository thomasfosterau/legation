# ADR-0031: pnpm 11 + Vite+ replace the bun workspace

Date: 2026-10-22
Status: Accepted (the owner's family tooling standard; supersedes the toolchain parts of ADR-0001 and ADR-0003)

## Context

legation was a bun workspace (ADR-0001: "a bun-workspaces monorepo"): a Bun catalog in the root `package.json`, `bun.lock`, Prettier, a standalone `.oxlintrc.json`, `tsc --build` project references for the build, Vitest invoked directly, and a release script (`scripts/release.ts`) that repacked every tarball with `bun pm pack`, because `npm pack` copies `workspace:` and `catalog:` specifiers verbatim (#267) and `bun publish` cannot do npm OIDC trusted publishing.

Every other repository the owner maintains (effect-web, effect-drizzle-ext, effect-schema-ext, pulpit, components, the applications) runs one toolchain: pnpm 11 with a strict catalog, Vite+ (`vp`) for format, lint, tests, tasks and library builds, the Effect lint presets, fallow, and the same CI and release workflows. The owner asked for every repository to meet that standard, Node and pnpm only.

## Decision

1. **pnpm 11 workspace.** Versions live in `pnpm-workspace.yaml`: `catalogMode: strict`, the dev pins in `catalog`, the published peer ranges in `catalogs.peers`, `overrides` forcing the `effect`, `vite` and `vitest` singletons and holding `@effect/platform-node-shared` at the catalog's Effect pin. Manifests carry only `catalog:`, `catalog:peers` and `workspace:` specifiers. `minimumReleaseAge` holds new third-party versions for a day. `nodeLinker: hoisted` keeps the flat layout bun had.
2. **Vite+ for everything the scripts did.** The root `vite.config.ts` owns Oxfmt (configured to the existing Prettier style, so nothing was reformatted), Oxlint with `@effect/tsgo`'s and `@mpsuesser/oxlint-plugin-effect`'s `recommended` presets, `vp staged`, the root tasks (`build`, `pack:check`, `check`, `check:examples`, `test`, `test:coverage`, `bench`) and the Vitest projects that were `vitest.config.ts`. Tests import from `vite-plus/test` (or `@effect/vitest`), never `vitest`.
3. **`vp pack` builds the packages.** Each package's `vite.config.ts` instantiates `vite.package.ts`: one ESM bundle and `.d.ts` per entry, `.js` / `.d.ts` names, nothing from npm bundled. The entries and `exports` are unchanged (`./internal`, `./kit`, svelte's `index.svelte.js`, devtools' raw `./svelte` source). The `tsc` program is now only the type gate (`vp run check`, the native TypeScript 7 compiler patched by `@effect/tsgo`), with TypeScript 6 installed under the `@typescript/typescript6` alias for JS-API consumers (svelte-check, tsdown's declaration bundler, the language service).
4. **Release path.** `pnpm pack` rewrites `workspace:` and `catalog:` itself, so `scripts/publish.mjs` (the components library's path) packs each unpublished package once, runs the checks `release:check` ran (moved to `scripts/pack.mjs`, run on every PR as `vp run pack:check`: no leftover specifier, internal ranges, no exact `effect` peer, `svelte` conditions packed, publint strict, attw ESM-only) and uploads that tarball with `npm publish` under OIDC. The release job installs with `--ignore-scripts`.
5. **fallow** runs with package zones mirroring ADR-0006's dependency boundaries and reads the coverage map `vp run test:coverage` writes.

## Consequences

- One toolchain across the owner's repositories: an agent or contributor who knows one knows this one, and `vp` / `pnpm` are the only entry points.
- `bun.lock` and the Bun catalog are gone; Dependabot updates the pnpm catalogs through the `npm` ecosystem, with the lockstep sets grouped.
- `dist/` is bundled per entry instead of mirroring `src/` file by file. Nothing published resolved a deep path (`exports` names only the entries), and the two `legation-effect` entries share one chunk, so a value reached through both is still one instance.
- The Effect lint presets were adopted with their large rules at `warn` (ported-code allowances, each with its count); they are paid down to `error` over time.
- ADR-0001's "bun-workspaces monorepo" and ADR-0003's "Bun catalog / `bun.lock`" describe the toolchain of their time; the package structure and the Effect pin-and-floor policy they record stand.
