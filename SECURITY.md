# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/legation/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected package and version.

## Scope

legation is a sync engine: its packages move application data between clients, a sync server and a backend. Findings of particular interest are anything that lets a client read rows outside its authorized subsets (relationship-scoped read authorization, ADR-0015), apply a mutation the server's authorization should refuse, poison another client's replica or journal, or reach the backend through the JSON:API façade or the HTTP / WebSocket sync transport in a way the application did not expose.

## Supply-chain hardening

These packages are published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Once the source repository is public, every version the release workflow publishes carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), linking the artifact to the exact source commit and workflow. npm attaches it only when the source repository and the package are both public; it is never forced, because an explicit request fails from a private repository.
- **The checked tarball is the published tarball.** `scripts/publish.mjs` packs each package once with `pnpm pack`, checks that tarball (no leftover `workspace:` / `catalog:` specifier, no exact `effect` peer, publint strict, arethetypeswrong) and uploads that same file.
- **Install scripts disabled in the release job.** The release workflow installs with `pnpm install --frozen-lockfile --ignore-scripts` and turns off pnpm 11's `verify-deps-before-run` for that job (`pnpm_config_verify_deps_before_run: "false"`), so a later `pnpm run` cannot silently re-install with scripts; a compromised (transitive) dependency cannot execute install hooks in the privileged publish job. Everywhere else, dependency build scripts are opt-in (`allowBuilds` in `pnpm-workspace.yaml`). The only tool installed in that job is npm, pinned to a major (`npm@11`, for OIDC publishing).
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code. Dependabot proposes their updates for review.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false` and holds read permissions only.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for a day before pnpm will install them; Dependabot proposes updates with the same cooldown, and CI runs `pnpm audit --audit-level high` on every pull request.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
