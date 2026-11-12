/**
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`), the root tasks (`build`,
 * `check`, `check:examples`, `pack:check`, `test`, `test:coverage`, `bench`)
 * and the one Vitest run that covers every package and the example apps.
 * Each package's own `build` (`vp pack`) is defined once in `vite.package.ts`
 * and instantiated by its `packages/<name>/vite.config.ts`; a new package adds
 * itself to the `packages` list below.
 */
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { defineConfig } from "vite-plus";

/** The published packages, by directory; each has a `build` task. */
const packages = [
  "effect",
  "alchemy-cloudflare",
  "auth",
  "browser",
  "devtools",
  "jsonapi",
  "svelte",
] as const;

/** Every package's `build`, named explicitly: the root has no package deps. */
const buildAll = packages.map((name) =>
  name === "effect" ? "@thomasfosterau/legation#build" : `@thomasfosterau/legation-${name}#build`
);

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests import the packages by name, exactly as a consumer would, and resolve
 * that name to `src/` rather than the built `dist/` that `exports` points at,
 * so a unit run never needs a build first. (The commerce façade's browser test
 * builds the example app, which resolves through `dist/`; hence the `build`
 * edge on the test tasks.)
 */
const alias = {
  "@thomasfosterau/legation/internal": source("packages/effect/src/internal.ts"),
  "@thomasfosterau/legation/sql": source("packages/effect/src/sql/index.ts"),
  "@thomasfosterau/legation": source("packages/effect/src/index.ts"),
  "@thomasfosterau/legation-browser/http-cache": source("packages/browser/src/http-cache.ts"),
  "@thomasfosterau/legation-browser": source("packages/browser/src/index.ts"),
  "@thomasfosterau/legation-alchemy-cloudflare": source("packages/alchemy-cloudflare/src/index.ts"),
  "@thomasfosterau/legation-auth/client": source("packages/auth/src/client.ts"),
  "@thomasfosterau/legation-auth": source("packages/auth/src/index.ts"),
  "@thomasfosterau/legation-jsonapi": source("packages/jsonapi/src/index.ts"),
  "@thomasfosterau/legation-svelte/kit": source("packages/svelte/src/kit/index.ts"),
  "@thomasfosterau/legation-svelte": source("packages/svelte/src/index.svelte.ts"),
  "@thomasfosterau/legation-devtools": source("packages/devtools/src/index.ts"),
};

/**
 * Input fingerprint for the cached root tasks: auto tracking minus
 * node_modules bookkeeping churn, with the lockfile back explicitly.
 */
const cacheInputs = [{ auto: true }, "!node_modules/**", "!coverage/**", "pnpm-lock.yaml"];

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit). Format with fixes,
  // lint without: with type-aware lint on, `vp check --fix` would apply the
  // autofixes of type-aware rules (even ones at `warn`) to staged files at
  // commit time, so the commit would differ from the tree that was verified.
  // Oxfmt cannot format `.svelte`, so Svelte goes through lint alone; the
  // example apps' `.svelte` files are outside lint's patterns, so a commit
  // touching only those must not fail on "no files found".
  staged: {
    "*.{js,mjs,ts,json,md,yml,yaml}": [
      "vp check --fix --no-lint",
      "vp check --no-fmt --no-error-on-unmatched-pattern",
    ],
    "*.svelte": "vp lint --no-error-on-unmatched-pattern",
  },
  // Oxfmt, the formatter of record. The options keep the style the
  // repository was written in under Prettier, so the migration reformatted
  // nothing. The example apps, the vendored skills and ADR-0012/0013's
  // native ports are not formatted.
  fmt: {
    printWidth: 100,
    trailingComma: "es5",
    ignorePatterns: [
      "**/dist/**",
      "coverage/**",
      "examples/**",
      ".claude/skills/**",
      ".changeset/*.md",
      "**/CHANGELOG.md",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "coverage/**",
      "**/node_modules/**",
      ".changeset/**",
      // The example apps are demo code type-checked by their own
      // svelte-check (`vp run check:examples`); the library lint does not
      // apply to them, except for their Effect imports (`lint:examples`).
      "examples/**",
    ],
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "eslint/no-underscore-dangle": ["warn", { allow: ["_tag"] }],
      "typescript/no-explicit-any": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      // Every `postMessage` here is a `BroadcastChannel` / `MessagePort` /
      // worker post, none of which takes a `targetOrigin` (that argument
      // exists only on `Window.postMessage`, which nothing here calls).
      "unicorn/require-post-message-target-origin": "off",
      // `casting-awareness` is an awareness prompt, not a defect rule: it
      // fires on every `as`, including the narrowings the platform types
      // (IndexedDB, Durable Objects, WebSocket) structurally require. Stays
      // visible as a warning.
      "effect/casting-awareness": "warn",

      // ---- Effect preset: rules this workspace's conventions cut across ----
      // `prefer-option-over-null` goes to `error` once every surface is
      // converted (owner decision, #562): an option-bag member is
      // `readonly x?: T` (no `| undefined`: a caller holding `undefined` omits
      // the key), `x?: Option.Option<T>` only where "no value" is itself an
      // answer, and an absent return or result field is an `Option`. Optional
      // parameters stay `x?: T`; wire shapes keep their native optionals.
      // legation-jsonapi is converted (its can't-applies are file-scoped
      // overrides below); the other packages still have sites.
      "effect/prefer-option-over-null": "warn",
      // `unknown` is the honest type at the boundaries this engine sits on:
      // a row value before its collection's schema decodes it, a mutator's
      // encoded args, a caught failure. Parsing them earlier would decode
      // twice or change the wire shape.
      "effect/no-unknown-parameters": "warn",
      // The same boundary on the way out is at `error` (#562): the one site
      // that returns an untyped row value (`Predicate.fieldValue`) lives in a
      // module of its own with a file-scoped override below. The derived
      // combinators (`Incremental`,
      // `Derive`) are typed by their row, so they return the caller's types.
      "effect/no-unknown-returns": "error",
      "effect/no-unsafe-dictionary-type": "warn",
      // At 0 sites (#562): narrow through `effect/Predicate` (`P.isString`),
      // which measured no slower than a `typeof` switch on the per-row
      // `Predicate.compareLiterals` path.
      "effect/no-runtime-typeof": "error",

      // ---- Effect preset: ported-code allowances ---------------------------
      // The engine predates the Effect oxlint preset. The rules below sit at
      // `warn` with the count left when it was adopted, so the code stays
      // committable while each site stays reported; a new site is a defect,
      // not headroom. Once a rule's count reaches zero its line is deleted,
      // so it is back at the preset's `error`. The remaining sites are listed
      // in #497 (see AGENTS.md "Effect"). Counts re-measured under
      // `@enfect/oxlint` 0.9.0 (#561).
      "effect/avoid-native-object-helpers": "warn", // 689 sites
      "effect/require-safety-comment-for-type-assertion": "warn", // 621 sites
      "effect/imperative-loops": "warn", // 366 sites
      "effect/yield-in-for-loop": "warn", // 535 sites
      "effect/avoid-direct-tag-checks": "warn", // 164 sites
      "effect/avoid-direct-json": "warn", // 161 sites
      "effect/prefer-effect-fn": "warn", // 124 sites
      "effect/no-known-value-widening": "warn", // 98 sites

      // ---- Type-aware rules (oxlint-tsgolint) -------------------------------
      // Turned on in #561. Each rule below is relaxed for a stated reason; a
      // `warn` carries the count it was adopted with, and a new site is a
      // defect (follow-up: #497).
      // Effect 4 marks much of its HTTP surface `@stability unstable`; the
      // native `tsc` gate already demotes this to a suggestion
      // (tsconfig.base.json, #279) for the same reason: it fires on every such
      // import and drowns real signal.
      "effecttsgo/unstable-api-usage": "off",
      // `unknown` in an error channel: the engine host's bridge effects and
      // the façade's write paths carry a caught failure as `unknown` (the
      // boundary `effect/no-unknown-parameters` names), as do test helpers
      // that fail with whatever a backend raised. 54 sites (21 in src).
      "effecttsgo/any-unknown-in-error-context": "warn",
      // `String(value)` on an untyped row value (a foreign key, a SQL
      // detector's COUNT/MAX column, the comparator's last-resort text form)
      // is the intended string form at that boundary. 7 sites (2 in tests).
      "typescript/no-base-to-string": "warn",
      // The public API spells `unknown | undefined` / `unknown | null` on
      // purpose: TypeScript collapses the union, but the reader learns the
      // value may be absent. The rule fires on exactly that spelling.
      "typescript/no-redundant-type-constituents": "off",

      // ---- paid down (#562): at error -------------------------------------
      // Rules whose last sites #562 fixed, pinned at `error` so a new site
      // fails the gate while their category is still at `warn`.
      "typescript/no-misused-spread": "error",
      "unicorn/no-array-reverse": "error",
      "oxc/no-map-spread": "error",
      // Tests run effects through `@effect/vitest` (`it.effect`, `it.live`, `layer(...)`), and the
      // shipped edges that run an effect do it with explicit services (`Effect.runForkWith`).
      "effecttsgo/strict-effect-provide": "error",
      "unicorn/prefer-array-find": "error",
      "typescript/no-unnecessary-boolean-literal-compare": "error",
      "effecttsgo/unnecessary-fail-yieldable-error": "error",
      "effecttsgo/flat-map-identity-to-flatten": "error",
      "effecttsgo/error-payload-shadows-name": "error",
      "effecttsgo/multiple-catch-tag": "error",
      "effecttsgo/unsafe-effect-type-assertion": "error",
      "effecttsgo/unnecessary-pipe-chain": "error",
      "effecttsgo/prefer-unsafe-constructor": "error",
      "effecttsgo/provide-layer-succeed-to-provide-service": "error",
      "effecttsgo/prefer-succeed-some-or-none": "error",
      "effecttsgo/return-effect-in-gen": "error",
      "effecttsgo/catch-to-or-else-succeed": "error",
      "effecttsgo/lazy-effect": "error",
      "effecttsgo/catch-to-ignore": "error",
      "effect/avoid-process-env": "error",
      "effecttsgo/run-effect-inside-effect": "error",
      "typescript/no-unnecessary-type-parameters": "error",
    },
    overrides: [
      // ---- Genuine can't-applies (#562) ------------------------------------
      // No inline disable comments: a site a rule cannot apply to lives in a
      // small private module named for the reason, and the rule is off for
      // that module alone. Each module's header repeats the reason.
      //
      // The measured tag dispatches stay `switch` statements: a hoisted
      // `Match` measured slower on each path (ns per call, median, node).
      // Per row: `addNumber` (`Aggregate.addToBucket`'s fold) `Match.type`
      // 4.3x, a Record table 1.8x (#667); `removeNumber`, its mirror, not
      // measured apart; `deltaFromChanges` `Match.type` 2.2x, `typeTags` 2.1x,
      // a table 1.2x (#667); `holds` `Match.when` ~7x, a table ~5x (#667).
      // Per emission or state (#562): `foldNumeric` `typeTags` 1.21x on a
      // 10-row `compute` (133 -> 160 ns); `emptyBucket` `typeTags` 1.47x on
      // an empty `initState` (44 -> 65 ns); `bucketValue` `Match.type` 2.3x on
      // `stateValue` (10 -> 23 ns) and +13% per emission over 10k groups,
      // `typeTags` 4.2x and +52%.
      {
        files: ["packages/effect/src/internal/RowDispatch.ts"],
        rules: {
          "effect/prefer-match-over-switch": "off",
        },
      },
      // Boolean fields a published wire names: `hydrated` (the `hydrate`
      // host-request kind's answer, ADR-0021 amendment §6; wire schemas stay
      // literal, so no `Schema.encodeKeys` rename) and `pulled` (a mirror
      // protocol coverage window, posted as its decoded value with no schema
      // encode, so the schema's type is the wire).
      {
        files: ["packages/effect/src/internal/WireFlags.ts"],
        rules: {
          "effect/require-is-prefix-for-boolean-schema-field": "off",
        },
      },
      // `Node.make`'s `Edges` default: `{}` is the only object type whose
      // `keyof` is `never` (`Record<string, never>` makes it `string`), and
      // `Record<never, Edge>` is the same `{}` under another spelling. The
      // `Edges extends Record<string, Edge>` bound rules out the hazard the
      // rule names.
      {
        files: ["packages/effect/src/internal/NoEdges.ts"],
        rules: {
          "effect/avoid-object-type": "off",
        },
      },
      // A node's row codec asserted service-free for `Collection.make`.
      // `AnyNode` could state it, but `NodeBridge` builds nodes from
      // effect-jsonapi's open `Resource.Any`, so a bridged node is not
      // service-free by its type; the fix is upstream (#695).
      {
        files: ["packages/effect/src/internal/NodeRowCodec.ts"],
        rules: {
          "effect/avoid-any": "off",
          "effect/no-chained-type-assertions": "off",
        },
      },
      // `Predicate.fieldValue`: a field of an encoded row value, which nothing
      // decodes on read (ADR-0014); evaluation compares it as a raw literal
      // (ADR-0028). Typed rows are #696.
      {
        files: ["packages/effect/src/internal/EncodedField.ts"],
        rules: {
          "effect/no-unknown-returns": "off",
        },
      },
      // `FanoutShard.ShardObject.publish` is a Durable Object RPC method:
      // Alchemy's stub turns every member access into a call, so the broker
      // can only call `publish()`, and the shard, named by its topic, has no
      // argument to take.
      {
        files: ["packages/alchemy-cloudflare/src/internal/ShardRpc.ts"],
        rules: {
          "effecttsgo/lazy-effect": "off",
        },
      },
      // legation-jsonapi's `null`s:
      // - `StoredLinkage`: a row value's linkage as stored. The engine never
      //   decodes a stored row on read (ADR-0014), so the type is the stored
      //   JSON, whose empty to-one is `null`.
      // - `JsonApiWire`: JSON:API wire shapes serialised as is, an empty
      //   to-one linkage `data: null` and a single-resource read that matched
      //   nothing `data: null` (effect-jsonapi's `Handlers.data`).
      // - `ResolvedRelation`: follows the core's `Related.RelatedValue`
      //   (`null` empty, `undefined` not in the mirror), which the core's
      //   join compares by reference and the mirror protocol carries raw. It
      //   becomes an `Option` with the core's `Related` (Option-everywhere,
      //   owner decision on #562), the wire unchanged.
      {
        files: [
          "packages/jsonapi/src/internal/StoredLinkage.ts",
          "packages/jsonapi/src/internal/JsonApiWire.ts",
          "packages/jsonapi/src/internal/ResolvedRelation.ts",
        ],
        rules: {
          "effect/prefer-option-over-null": "off",
        },
      },
      // A benchmark's console output is its product: it prints the numbers
      // it measured, outside any Effect runtime.
      {
        files: ["**/*.bench.ts"],
        rules: {
          "effect/use-console-service": "off",
        },
      },
      // Type-level tests: each expect-error directive IS the assertion (a
      // statement that must fail to compile), checked by the `check` task.
      {
        files: [
          "packages/effect/src/__tests__/typed-query.test.ts",
          "packages/effect/src/__tests__/node.test.ts",
          "packages/effect/src/__tests__/typed-reads.test.ts",
        ],
        rules: {
          "effect/avoid-ts-ignore": "off",
        },
      },
      // The tests read the environment at collection time, before any Effect
      // runtime exists: `DATABASE_URL` selects the PostgreSQL suites, `CI`
      // turns their skip into a failure and `LEGATION_CORPUS_SEED` seeds the
      // corpora Vitest builds while it collects the file. There is no `Config`
      // provider to read them through yet, so this one module reads
      // `process.env` and every test imports it from there.
      {
        files: ["packages/effect/src/__tests__/env.ts"],
        rules: {
          "effect/avoid-process-env": "off",
        },
      },
      // Build/test configs and the release scripts are evaluated by Vite,
      // Vitest and Node directly, before any Effect runtime exists: there is
      // no `Config` provider to read and no `FileSystem` service to call, so
      // `process.env` and `node:*` are the only things that work there.
      {
        files: ["**/vite.config.ts", "vite.package.ts", "scripts/**", "vitest.global-setup.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-command-executor-service": "off",
          "effect/use-temp-file-scoped": "off",
          // Plain Node build tooling (the pack checks, the publish step, the
          // example typecheck runner): `try`/`catch`, `typeof` and `JSON` on a
          // packed `package.json` are the idiom where no Effect runtime runs.
          "effect/avoid-try-catch": "off",
          "effect/prefer-effect-is": "off",
          "effect/no-runtime-typeof": "off",
          "effect/avoid-direct-json": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
        },
      },
      {
        files: ["packages/*/src/**/__tests__/**/*.ts"],
        rules: {
          "vitest/no-standalone-expect": [
            "error",
            {
              additionalTestBlockFunctions: [
                "it.effect",
                "it.live",
                "it.scoped",
                "it.scopedLive",
                "it.layer",
              ],
            },
          ],
          "vitest/expect-expect": [
            "error",
            { assertFunctionNames: ["expect", "expect*", "check*"] },
          ],
          "vitest/valid-expect": ["error", { maxArgs: 2 }],
          "vitest/no-conditional-expect": "off",
          "vitest/require-to-throw-message": "off",
        },
      },
      {
        files: ["packages/*/src/**/__tests__/**/*.bench.ts"],
        rules: {
          "vitest/expect-expect": [
            "error",
            { assertFunctionNames: ["expect", "expect*", "check*", "bench", "bench.*"] },
          ],
        },
      },
    ],
    // Type-aware lint through oxlint-tsgolint (patched by `effect-tsgo patch
    // --oxlint`, so `effecttsgo/*` rules run too). tsgolint types each file
    // under its nearest tsconfig.json: the packages' own cover `src/` and the
    // `src/__tests__/tsconfig.json` files (and `packages/devtools/svelte/`)
    // extend tsconfig.check.json, so a clean tree with no `dist/` types the
    // same program the `check` gate does. `typeCheck` reports compiler
    // errors too; the Effect-patched `tsc` run stays the type gate of record.
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  },
  run: {
    tasks: {
      // Every package's `dist/` (`vp pack`), in dependency order.
      build: {
        command: "echo 'build: every package packed'",
        dependsOn: buildAll,
        cache: false,
      },
      // The type gate: every package's `src` and tests in one native,
      // Effect-patched `tsc` program (tsconfig.check.json maps the package
      // names to `src/`, so no build is needed first).
      check: {
        command: "tsc -p tsconfig.check.json",
        cache: { input: cacheInputs, output: [] },
      },
      // Each example app's own `tsc` / `svelte-check`. The apps resolve the
      // packages through `dist/`, as they do at runtime. The examples'
      // import lint runs first.
      "check:examples": {
        command: "node scripts/typecheck-examples.mjs",
        dependsOn: ["build", "lint:examples"],
        cache: false,
      },
      // The example apps are outside the library lint (`lint.ignorePatterns`),
      // but they are what consumers copy, so their Effect imports follow the
      // library's convention: `effect/prefer-namespace-imports` alone, from
      // examples/oxlint.namespace-imports.json. Oxlint's `overrides` cannot
      // turn categories off per directory, so this is a run of its own.
      "lint:examples": {
        command: "oxlint -c examples/oxlint.namespace-imports.json examples",
        cache: false,
      },
      // Packs every publishable package the way the release does and lints
      // the tarball (scripts/pack-check.mjs). No registry access.
      "pack:check": {
        command: "node scripts/pack-check.mjs",
        dependsOn: ["build"],
        cache: false,
      },
      test: {
        command: "vp test run",
        dependsOn: ["build"],
        cache: false,
      },
      // The whole suite under one coverage map (`coverage/coverage-final.json`),
      // which `fallow audit` reads for exact per-function CRAP scores
      // (`health.coverage` in .fallowrc.json). Run this before `fallow audit`.
      "test:coverage": {
        command: "vp test run --coverage",
        dependsOn: ["build"],
        cache: false,
      },
      bench: {
        command: "vp test bench --run --reporter=verbose",
        cache: false,
      },
      // What CI runs (.github/workflows/ci.yml, on Node.js lts and latest):
      // AGENTS.md "Verification", in its order. The PostgreSQL overlap test
      // reads `DATABASE_URL` (the workflow's service sets it; it skips when
      // unset), and `fallow audit` reads the coverage map `test:coverage`
      // writes, against `origin/trunk` (fetch it first).
      ci: {
        command: [
          "vp check",
          "vp run build",
          "vp run pack:check",
          "vp run check",
          "vp run check:examples",
          "vp run ci:chromium",
          "vp run test:coverage",
          "pnpm audit --audit-level high",
          "fallow audit --ci --base origin/trunk",
        ],
        cache: false,
      },
      // The tests of one published `effect` floor (`FLOOR`: core,
      // alchemy-cloudflare, auth or jsonapi), after CI's `floor` job has
      // pointed the catalog at it and installed (scripts/effect-floor.mjs).
      "ci:floor": {
        command: "node scripts/effect-floor.mjs test",
        cache: false,
      },
      // Chromium for the commerce façade's browser test (`test:coverage`),
      // with its system libraries (`--with-deps`: apt on Linux, via sudo when
      // not root). A no-op download when it is already installed.
      "ci:chromium": {
        command: "playwright-core install --with-deps chromium",
        cache: false,
      },
    },
  },
  resolve: {
    alias,
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "examples/realworld/tests/**/*.test.ts"],
          // The binding tests mount components and need the `svelte`
          // project below; the /kit tests are plain node. The packages with
          // an `effect` floor of their own have projects of their own below.
          exclude: [
            "**/node_modules/**",
            "packages/svelte/src/__tests__/**",
            "packages/alchemy-cloudflare/src/__tests__/**",
            "packages/auth/src/__tests__/**",
            "packages/jsonapi/src/__tests__/**",
          ],
        },
      },
      {
        // legation-jsonapi's suite, apart for the same reason as the two
        // below: its `effect` floor is `catalogs.jsonapi-peers` (4.1.0, which
        // effect-jsonapi 0.22 requires), so the core floor job (4.0.0) must not
        // select it. The commerce example drives the façade over
        // effect-jsonapi, so its tests share the floor and the project (its
        // browser tests run in `commerce-browser`, after its build).
        extends: true,
        test: {
          name: "jsonapi",
          environment: "node",
          // Materializes the example app's generated tsconfig on fresh clones.
          globalSetup: ["./vitest.global-setup.ts"],
          include: ["packages/jsonapi/src/**/*.test.ts", "examples/commerce/tests/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "examples/commerce/tests/facade-browser.test.ts",
            "examples/commerce/tests/snapshot-browser.test.ts",
          ],
        },
      },
      {
        // The Alchemy adapter's suite, apart because it has its own `effect`
        // floor (`catalogs.alchemy-peers`, 4.1.0, which Alchemy requires):
        // CI's `floor` job ("ci:floor (…)") runs it at that floor and every other
        // project at the core's.
        extends: true,
        test: {
          name: "alchemy-cloudflare",
          environment: "node",
          include: ["packages/alchemy-cloudflare/src/**/*.test.ts"],
        },
      },
      {
        // The effect-auth bridge's suite, apart for the same reason: its
        // `effect` floor is `catalogs.auth-peers` (4.1.0, which effect-auth
        // requires), so CI's `floor` job ("ci:floor (…)") runs it at that floor.
        // The audience example (#221) composes effect-auth with the engine
        // and the façade, so its tests share the floor and the project.
        extends: true,
        test: {
          name: "auth",
          environment: "node",
          include: ["packages/auth/src/**/*.test.ts", "examples/audience/tests/**/*.test.ts"],
        },
      },
      {
        // The commerce façade's browser test serves the app's production
        // build. Its global setup builds the app once, before the parallel
        // test phase (#289): a `vite build` inside the test's `beforeAll`
        // competed with every other file for CPU, so its wall time scaled
        // with host load. Vitest runs the setup only when this project has
        // files in the run.
        extends: true,
        test: {
          name: "commerce-browser",
          environment: "node",
          globalSetup: [
            "./vitest.global-setup.ts",
            "./examples/commerce/tests/support/global-setup.ts",
          ],
          include: [
            "examples/commerce/tests/facade-browser.test.ts",
            "examples/commerce/tests/snapshot-browser.test.ts",
          ],
          server: {
            deps: {
              // The test's `beforeAll` imports the app's built server
              // (`build/handler.js` and its ~60 chunks). Vitest inlines every
              // module outside node_modules, so without this the whole bundle
              // went through vite's transform pipeline in the main process and
              // back over RPC: about 4.5x the CPU of a native import (1.2 s
              // against 0.27 s). Under a load average of ~95 on 4 cores that
              // import alone took 113 s and timed the hook out at 120 s; loaded
              // natively it took 5-29 s (#472). The build is plain Node ESM:
              // load it the way `node build` serves it.
              external: [/\/examples\/commerce\/build\//],
            },
          },
        },
      },
      {
        // The Svelte bindings mount real components, so this project compiles
        // `.svelte` fixtures and resolves Svelte's client (browser) build.
        extends: true,
        // `experimental.async` so fixtures can exercise the binding's
        // awaitable surface (`Live.promise`) inside <svelte:boundary>.
        plugins: [svelte({ compilerOptions: { experimental: { async: true } } })],
        resolve: {
          conditions: ["browser"],
        },
        test: {
          name: "svelte",
          environment: "jsdom",
          include: ["packages/svelte/src/__tests__/**/*.test.ts"],
          server: {
            deps: {
              // Vitest externalizes node_modules by default — even a package
              // carrying a `svelte` export condition — so effect-svelte must
              // be inlined to run through vite's browser pipeline; externalized
              // its `import "svelte"` loads the SERVER runtime and every
              // provide()/setContext throws lifecycle_outside_component. (The
              // app's vite build needs no such flag: the `svelte` condition on
              // effect-svelte >= 0.3.2 makes vite-plugin-svelte handle it.)
              inline: ["@thomasfosterau/effect-svelte"],
            },
          },
          // Component tests poll the DOM while engine fibers settle; leave
          // headroom for cold-start transform/import under parallel workers.
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      // `json` writes coverage-final.json, the map `fallow audit` reads.
      reporter: ["text-summary", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/__tests__/**", "packages/*/dist/**"],
      // Temporarily lowered during the v2 rebuild (ADRs 0007-0010) while
      // skeleton modules await their phase-2/3 implementations; restore to
      // 85/70/80/85 as coverage recovers.
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 65,
        lines: 70,
      },
    },
  },
});
