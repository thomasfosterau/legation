/**
 * The repository's GitHub configuration, declared.
 *
 * The workflows, CONTRIBUTING.md and PUBLISHING.md assume settings that are
 * otherwise made by hand in the GitHub UI and drift silently: the merge
 * methods, the `release` environment that gates publishing, the triage labels
 * the agent skills apply, and the `Trunk` ruleset whose required checks are
 * the CI legs by name. This stack declares them, so `vp run github:plan`
 * shows any drift and `vp run github:deploy` corrects it.
 *
 * It is owner-run, never in CI or an agent session: it needs an admin-scoped
 * GitHub token (`GITHUB_TOKEN`, or `gh auth token`) and the Cloudflare
 * credentials of the state store (`CLOUDFLARE_API_TOKEN`,
 * `CLOUDFLARE_ACCOUNT_ID`), read from `.env` or the environment.
 *
 * The values declared are the repository's settings as they stood when this
 * stack was written, so the first plan should show no change to make. Change a
 * setting here, not in the UI.
 *
 * Not declared:
 * - **Secrets and variables.** The workflows read none: npm publishing is OIDC
 *   trusted publishing, and every other job uses the workflow's own
 *   `GITHUB_TOKEN`. A secret declared here would also sit in the state store
 *   in plaintext (Alchemy state encodes a `Redacted` as its value).
 * - **Code security settings** (secret scanning, push protection, Dependabot
 *   security updates): the provider's `Repository` has no props for them.
 * - **Actions permissions** (allowed actions, the default `GITHUB_TOKEN`
 *   scope): the provider has no resource for them. Every workflow sets
 *   `permissions: {}` and grants per job, so the default scope never applies.
 *
 * @module stacks/github
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const owner = "thomasfosterau";
const repository = "legation";

/** The owner's login: the required reviewer on the `release` environment. */
const ownerLogin = "thomasfosterau";

/**
 * Every label on the repository: the triage labels `docs/agents/triage-labels.md`
 * maps the skills' roles onto, the area labels, Dependabot's `dependencies` and
 * `javascript`, and GitHub's defaults. Colours and descriptions are the ones
 * already on the repository; a label with no description has none here.
 */
const labels: ReadonlyArray<{
  readonly name: string;
  readonly color: string;
  readonly description?: string;
}> = [
  { name: "status: needs-triage", color: "ededed" },
  { name: "status: agent-ready", color: "ededed" },
  { name: "needs-triage", color: "ededed" },
  { name: "ready-for-agent", color: "ededed" },
  { name: "ready-for-human", color: "ededed" },
  { name: "design", color: "ededed" },
  { name: "implementation", color: "ededed" },
  { name: "filter-grammar", color: "ededed" },
  { name: "service-worker", color: "ededed" },
  { name: "store", color: "ededed" },
  { name: "sync-protocol", color: "ededed" },
  { name: "test", color: "ededed" },
  { name: "phase-1", color: "ededed" },
  { name: "phase-2", color: "ededed" },
  { name: "phase-4", color: "ededed" },
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  {
    name: "dependencies",
    color: "0366d6",
    description: "Pull requests that update a dependency file",
  },
  {
    name: "documentation",
    color: "0075ca",
    description: "Improvements or additions to documentation",
  },
  { name: "duplicate", color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "help wanted", color: "008672", description: "Extra attention is needed" },
  { name: "invalid", color: "e4e669", description: "This doesn't seem right" },
  {
    name: "javascript",
    color: "168700",
    description: "Pull requests that update javascript code",
  },
  { name: "question", color: "d876e3", description: "Further information is requested" },
  { name: "wontfix", color: "ffffff", description: "This will not be worked on" },
];

/** A label's resource id: its name with every run of other characters replaced by `-`. */
const labelId = (name: string) => `Label-${name.replace(/[^a-z0-9]+/gi, "-")}`;

export default Alchemy.Stack(
  "LegationGitHub",
  {
    // `Cloudflare.providers()` is registered only because the state store is
    // Cloudflare's; the stack declares no Cloudflare resource.
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
    state: Cloudflare.state(),
    secrets: [Alchemy.Secrets.DotEnv(), Alchemy.Secrets.ProcessEnv()],
  },
  Effect.gen(function* () {
    // `retain` is the provider's default removal policy, and create converges
    // on the existing repository.
    yield* GitHub.Repository("Repository", {
      owner,
      name: repository,
      description: "An experimental Effect-based library for arbitrary synchronisation of data.",
      visibility: "public",
      defaultBranch: "trunk",
      hasIssues: true,
      hasProjects: true,
      hasWiki: false,
      hasDiscussions: true,
      allowSquashMerge: true,
      allowMergeCommit: true,
      allowRebaseMerge: true,
      allowAutoMerge: true,
      deleteBranchOnMerge: true,
      topics: [
        "effect",
        "effect-ts",
        "local-first",
        "offline-first",
        "progressive-enhancement",
        "progressive-web-app",
        "service-worker",
      ],
    });

    // `release.yml`'s `publish` job, the only one with `id-token: write`:
    // only `trunk` may deploy to it, and the owner approves each release
    // (PUBLISHING.md, "Protect the `release` environment").
    yield* GitHub.Environment("ReleaseEnvironment", {
      owner,
      repository,
      name: "release",
      preventSelfReview: false,
      reviewers: { users: [ownerLogin] },
      deploymentBranchPolicy: { customBranchPolicies: ["trunk"] },
    });

    // One resource per label, in order: there is nothing to win by racing.
    yield* Effect.forEach(
      labels,
      (label) => GitHub.Label(labelId(label.name), { owner, repository, ...label }),
      { concurrency: 1, discard: true }
    );

    // The required checks are the two CI legs by name (CONTRIBUTING.md "CI
    // expectations"): renaming a leg means changing them here in the same
    // change. Not strict: an up-to-date requirement would push contributors
    // to GitHub's Update-branch button, which merges `trunk` in.
    // `Ruleset` finds its ruleset only by the id in its state, so delete the
    // hand-made `Trunk` ruleset (Settings → Rules) before the first deploy, or
    // the deploy creates a second one beside it.
    yield* GitHub.Ruleset("TrunkRuleset", {
      owner,
      repository,
      name: "Trunk",
      enforcement: "active",
      target: "branch",
      conditions: { include: ["~DEFAULT_BRANCH"] },
      deletion: true,
      nonFastForward: true,
      requiredStatusChecks: {
        checks: [
          { context: "ci (node latest)", integrationId: 15368 },
          { context: "ci (node lts)", integrationId: 15368 },
        ],
        strictRequiredStatusChecksPolicy: false,
      },
      pullRequest: {
        requiredApprovingReviewCount: 0,
        dismissStaleReviewsOnPush: false,
        requireCodeOwnerReview: false,
        requireLastPushApproval: false,
        requiredReviewThreadResolution: false,
        requireExtraApprovalForUnattributedChanges: true,
        allowedMergeMethods: ["merge", "squash", "rebase"],
      },
    });
  })
);
