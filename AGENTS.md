# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first. Before changing an area, read [CONTEXT.md](CONTEXT.md) (the glossary), the [ADRs](docs/adr/) for it and the package's own `AGENTS.md`.

## Process

- Agents may open PRs in this repository. Out-of-scope work you spot becomes an issue; then move on.
- Use the GitHub MCP tools or `gh` as available, and write only to `thomasfosterau/legation`.
- The vendored skills in `.claude/skills/` read this repository's conventions from [docs/agents/](docs/agents/).
- Use Effect idioms and Effect's own modules; where existing code doesn't, file an issue unless the fix is trivial.
- If a gate can't run here (Chromium, PostgreSQL, network), say which in the PR body; never imply it ran.

## Pitfalls

- **Package boundaries are by dependency.** Code that needs only `effect` goes in `packages/effect`, which imports no runtime (`node:*`, DOM) so it runs everywhere; anything needing another library or a framework is its own package. `.fallowrc.json` enforces the graph.
- **`.` vs `./internal`.** Engine seams (`ClientEngine`, `Subset`, `SyncServer`, `Cvr`, …) are not on the root entry, so docs and examples must import them from `@thomasfosterau/legation/internal`.
- **`effect` is a peer, never a dependency**: two copies break `Context` identity. Never edit a version in a `package.json`.
- **`dist/` is the product**: the example apps and the browser test consume it, while tests and `vp run check` resolve the packages to `src/`.
- **Publish only through the Release workflow** (`vp run release`): it runs `pack:check` on the commit it publishes, and `npm publish` in a package directory would ship `workspace:` / `catalog:` specifiers verbatim. Release-path registry calls go through `vp pm` (`publish`, `view`), never `npm` / `pnpm` directly.
- **Wire and storage formats are protocol** (`Protocol.ts`, `MirrorProtocol.ts`, the `ClientStore` layout): changing one needs a migration and a changeset that says so.

## Fallow

- `vp install` links the `fallow` skill into `.claude/skills/fallow` from the installed package (approved in `pnpm-workspace.yaml` `permissions`); the repository's own rules (the pre-commit `fallow:audit` gate, the boundaries in `.fallowrc.json`) are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
