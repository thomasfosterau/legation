# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Add a changeset with your change (`pnpm changeset`; see [CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. On merge to `trunk`, the [Release](../.github/workflows/release.yml) workflow opens or updates the **"chore: version packages"** PR, which applies the bumps and changelogs.
3. Merging it and approving the `release` environment runs `vp run release` on that commit: the build, then `vp run pack:check` (each package packed with `pnpm pack`, which rewrites `workspace:` and `catalog:` specifiers, and its tarball checked), then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts`. pnpm publishes every public package whose version isn't on npm yet, in dependency order, under OIDC, attaching provenance by itself; re-runs skip what is already published. Last, `changeset git-tag` tags each version not yet tagged and reports those tags to the Changesets action, which pushes them and creates the GitHub releases. A failed publish stops before tagging.

The checked tarballs are packed from the same commit as the published ones, not the same files: `pnpm publish` packs again. Both packs come from one checkout, build and lockfile in one job.

`vp run release:dry-run` builds, checks and lists what `vp pm publish` would publish, without publishing or tagging.

## One-time setup

1. **Settings → Actions → General**: allow GitHub Actions to create pull requests.
2. **Bootstrap each package**: a trusted publisher can only be attached to an existing package, so publish its first version by hand from a clean `trunk` as `thomasfosterau`: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`; push the tags it creates (`git push origin --tags`). Never publish from a package directory by hand.
3. **Trusted publisher** on npmjs.com for each package: GitHub Actions, repository `thomasfosterau/legation`, workflow `release.yml`, environment `release`.
4. **Protect the `release` environment** (required reviewer, `trunk` only) and `trunk` (PRs and passing CI required).

Step 4 and the rest of the repository's GitHub settings are declared in [`stacks/github.ts`](../stacks/github.ts): `vp run github:plan` shows drift and `vp run github:deploy` applies it (owner-run; it needs an admin-scoped `GITHUB_TOKEN` and the Cloudflare credentials of Alchemy's state store).
