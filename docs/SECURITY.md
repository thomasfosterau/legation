# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/thomasfosterau/legation/security/advisories/new) form, not a public issue. Include a description, reproduction steps and the affected package and version.

Of particular interest: anything that lets a client read rows outside its authorized subsets ([ADR-0015](adr/0015-relationship-scoped-read-auth.md)), apply a mutation the server should refuse, poison another client's replica or journal, or reach the backend through the JSON:API façade or the sync transport in a way the application did not expose.

## Supply chain

- Publishing uses npm trusted publishing (OIDC) from a protected `release` environment that needs manual approval; only that job holds `id-token: write`. Provenance is attached by npm where the repository allows it.
- The release checks the tarballs (`vp run pack:check`) on the commit it publishes, in the same job, before `vp pm publish`.
- Privileged jobs install with `--frozen-lockfile --ignore-scripts`; elsewhere, dependency build scripts are opt-in (`allowBuilds`).
- Workflows default to `permissions: {}`, check out without persisted credentials, and pin actions by tag, locked to commits in `.github/workflows/actions.lock`.
- pnpm holds new versions for 24 hours (`minimumReleaseAge`), and Dependabot waits a day; CI runs `pnpm audit --audit-level high`.
