# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Add a changeset with your change (`pnpm changeset`; see [CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. On merge to `trunk`, the [Release](../.github/workflows/release.yml) workflow opens or updates the **"chore: version packages"** PR, which applies the bumps and changelogs.
3. Merging it and approving the `release` environment builds every package and runs [`scripts/publish.mjs`](../scripts/publish.mjs): each public package whose version isn't on npm yet is packed with `pnpm pack` (which rewrites `workspace:` and `catalog:` specifiers), checked by [`scripts/pack.mjs`](../scripts/pack.mjs) (the same checks as `vp run pack:check`), and that tarball is published with `npm publish`. Re-runs skip what is already published. The Changesets action then tags the releases.

`vp run release:dry-run` packs and checks every unpublished package without publishing.

## One-time setup

1. **Settings → Actions → General**: allow GitHub Actions to create pull requests.
2. **Bootstrap each package**: a trusted publisher can only be attached to an existing package, so publish its first version by hand from a clean `trunk` as `thomasfosterau`: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run build && pnpm run release`; push the tags it reports. Never `npm publish` from a package directory.
3. **Trusted publisher** on npmjs.com for each package: GitHub Actions, repository `thomasfosterau/legation`, workflow `release.yml`, environment `release`.
4. **Protect the `release` environment** (required reviewer, `trunk` only) and `trunk` (PRs and passing CI required).

Step 4 and the rest of the repository's GitHub settings are declared in [`stacks/github.ts`](../stacks/github.ts): `vp run github:plan` shows drift and `vp run github:deploy` applies it (owner-run; it needs an admin-scoped `GITHUB_TOKEN` and the Cloudflare credentials of Alchemy's state store).
