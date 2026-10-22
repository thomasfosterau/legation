# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers). There is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the packages and the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. Which changes need one is set out in [AGENTS.md](AGENTS.md#branches-and-pull-requests).
2. **Merge to `trunk`.** The [`Release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"chore: version packages"** PR that applies the version bumps and rolls the changesets into each package's `CHANGELOG.md`. The version step is `pnpm run version`: `changeset version && vp fmt && pnpm install --lockfile-only`.
3. **Merge the version PR and approve the `release` environment.** With no changesets left, the workflow runs `pnpm run release`, which builds every package (`vp run build`) and runs [`scripts/publish.mjs`](scripts/publish.mjs):
   1. Every public package under `packages/` whose current version is not on npm yet is taken in dependency order. Versions already on npm are skipped, so a re-run after a partial failure publishes only what is missing.
   2. Each is packed with `pnpm pack`, which rewrites the `workspace:^` dependencies on sibling packages and every `catalog:` / `catalog:peers` specifier to real ranges; `npm pack` would copy them verbatim and ship an uninstallable manifest ([#267](https://github.com/thomasfosterau/legation/issues/267)).
   3. The tarball is checked by [`scripts/pack.mjs`](scripts/pack.mjs), the same checks CI's `vp run pack:check` runs on every pull request: no `workspace:` / `catalog:` specifier left, internal ranges matching each sibling's version, no exact `effect` / `@effect/*` peer (the published floor is an open range; CONTRIBUTING.md "Effect version upgrades"), every `svelte` export condition naming a packed file, and no [publint](https://publint.dev) (strict) or [arethetypeswrong](https://arethetypeswrong.github.io) finding. attw ignores the `node10` and `node16-cjs` resolution modes: the packages are ESM-only by design. A finding that isn't a real problem is suppressed in `attwSuppressions` in `scripts/pack.mjs`, with its reason ([#250](https://github.com/thomasfosterau/legation/issues/250)).
   4. `npm publish <tarball> --access public` uploads exactly the tarball that was checked. npm (>= 11.5.1; the job installs npm 11) exchanges the workflow's OIDC token for a short-lived publish token. Provenance is left to npm, which attaches it only when allowed (a public source repository); it is never forced, because an explicit request fails from a private repository.
   5. Each published package is reported on `CHANGESETS_OUTPUT`, and the Changesets action pushes the tags (`@thomasfosterau/legation-effect@0.2.0`, …) and creates the GitHub releases.

`pnpm run release:dry-run` builds, then packs and checks every unpublished package against the real registry state and prints where it left the tarballs, without publishing.

## Maintainer setup (one-time)

1. **Allow Actions to open the version PR.** **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**. Without it the built-in `GITHUB_TOKEN` cannot open pull requests even though the job grants `pull-requests: write`.
2. **Bootstrap each package on npm.** A trusted publisher can only be attached to a package that already exists. The packages publish under the `@thomasfosterau` user scope, which belongs to the npm account of the same name, so the first version of each package is published by hand from a clean checkout of `trunk`, logged in as `thomasfosterau` (`npm whoami`): `pnpm install --frozen-lockfile`, then `pnpm run release:dry-run` and inspect the tarballs, then `pnpm run release`. npm's 2FA prompt appears in the terminal. Push the local tags it reports with `git push origin --tags`. Never `npm publish` from a package directory (see step 3.2 above).
3. **Configure the trusted publisher** on npmjs.com for each `@thomasfosterau/legation-*` package → **Settings → Trusted Publisher**:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/legation`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

4. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** (yourself) and restrict deployment to the `trunk` branch, so publishing pauses for manual approval.
5. **Protect `trunk`.** Require pull requests and passing CI before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed version PR.
