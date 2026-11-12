/**
 * Bundle-size measurement for the size tests (#678): what a consumer's
 * bundler ships for one import, minified and gzipped.
 *
 * The packages are packed in memory with the workspace's own `vp pack`
 * settings (`packOptions` in vite.package.ts, `write: false`), then a
 * consumer entry is bundled against that output the way an app's bundler
 * sees the published package: each package name resolves through its
 * manifest's `exports` and the manifest's `sideEffects` flag governs
 * tree-shaking, while `effect` resolves from node_modules and is bundled.
 * So the measurement needs no prior build and catches a regression in the
 * pack settings, the `exports` map and the `sideEffects` flag alike.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import { build } from "vite-plus/pack";
import { rolldown, type Plugin } from "vite/rolldown";
import { packOptions } from "../../../../vite.package.js";
import { awaitPromise, type PromiseRejected } from "./await-promise.js";

/** The slice of a workspace `package.json` the measurement reads. */
export interface Manifest {
  readonly name: string;
  readonly sideEffects?: boolean;
  readonly exports: Readonly<
    Record<string, string | { readonly types?: string; readonly import?: string }>
  >;
}

/** A workspace package to pack: its directory (a `file:` URL ending in `/`) and manifest. */
export interface WorkspacePackage {
  readonly directory: URL;
  readonly manifest: Manifest;
}

/** One measured bundle. */
export interface BundleSize {
  /** Minified, gzipped bytes. */
  readonly gzip: number;
  /** Minified bytes. */
  readonly minified: number;
  /**
   * Every module that kept code in the bundle, by id: `effect/<path>` for
   * an `effect` module, `<package name>/<dist path>` for a workspace one.
   */
  readonly modules: ReadonlyArray<string>;
}

/** A packed package: its manifest and its `dist/` files by path. */
interface Packed {
  readonly manifest: Manifest;
  readonly directory: URL;
  readonly files: R.ReadonlyRecord<string, string>;
}

const virtualPrefix = "\0packed:";
const entryId = "\0entry";

/**
 * The entries `vp pack` builds for a manifest: under one module per source
 * module, `dist/<path>.js` is built from `src/<path>.ts`.
 */
const entriesOf = (manifest: Manifest): Record<string, string> =>
  R.fromEntries(
    Arr.getSomes(
      Arr.map(R.values(manifest.exports), (target) =>
        Option.fromNullishOr(P.isString(target) ? undefined : target.import).pipe(
          Option.flatMap((path) => Option.fromNullishOr(/^\.\/dist\/(.+)\.js$/.exec(path)?.[1])),
          Option.map((path): [string, string] => [path, `src/${path}.ts`])
        )
      )
    )
  );

const pack = (pkg: WorkspacePackage): Effect.Effect<Packed, PromiseRejected> =>
  awaitPromise(() =>
    build({
      ...packOptions(entriesOf(pkg.manifest)),
      config: false,
      cwd: pkg.directory.pathname,
      dts: false,
      sourcemap: false,
      clean: false,
      write: false,
      logLevel: "silent",
    })
  ).pipe(
    Effect.map((handle) => ({
      manifest: pkg.manifest,
      directory: pkg.directory,
      files: R.fromEntries(
        Arr.flatMap(handle.bundles, (bundle) =>
          Arr.flatMap(bundle.chunks, (chunk) =>
            chunk.type === "chunk" ? [[chunk.fileName, chunk.code] as const] : []
          )
        )
      ),
    }))
  );

/** `path` against the directory of `from`, both relative to a package's `dist/`. */
const join = (from: string, path: string): string =>
  new URL(path, new URL(from, "file:///")).pathname.slice(1);

/** A packed module's id: its package's name and its path in that package's `dist/`. */
const packedId = (pkg: Packed, path: string): string =>
  `${virtualPrefix}${pkg.manifest.name}/${path}`;

/** The packed package a module id belongs to, and the module's path in its `dist/`. */
const packedModule = (packages: ReadonlyArray<Packed>, id: string) =>
  Arr.findFirst(packages, (pkg) =>
    id.startsWith(packedId(pkg, ""))
      ? Option.some({ pkg, path: id.slice(packedId(pkg, "").length) })
      : Option.none()
  );

/** A package specifier (`name` or `name/subpath`) resolved through a packed manifest's `exports`. */
const exported = (packages: ReadonlyArray<Packed>, specifier: string) =>
  Arr.findFirst(packages, (pkg) => {
    const name = pkg.manifest.name;
    if (specifier !== name && !specifier.startsWith(`${name}/`)) return Option.none();
    return R.get(pkg.manifest.exports, `.${specifier.slice(name.length)}`).pipe(
      Option.flatMap((target) => Option.fromNullishOr(P.isString(target) ? target : target.import)),
      Option.map((path) => packedId(pkg, path.replace(/^\.\/dist\//, "")))
    );
  });

/** Serves the packed packages to the consumer bundle, as published packages would be. */
const packedPackages = (packages: ReadonlyArray<Packed>, entry: string): Plugin => ({
  name: "packed-packages",
  resolveId(source, importer) {
    if (source === entryId) return entryId;
    const from = Option.flatMap(Option.fromNullishOr(importer), (id) => packedModule(packages, id));
    if (source.startsWith(".")) {
      return Option.getOrNull(
        Option.map(from, ({ pkg, path }) => packedId(pkg, join(path, source)))
      );
    }
    const own = exported(packages, source);
    if (Option.isSome(own)) return own.value;
    // Anything else (`effect`) resolves from the importing package, as it
    // would from a consumer's node_modules.
    const directory = Option.match(from, {
      onNone: () => Option.fromNullishOr(packages[0]?.directory),
      onSome: ({ pkg }) => Option.some(pkg.directory),
    });
    return Option.isNone(directory)
      ? null
      : this.resolve(source, new URL("package.json", directory.value).pathname);
  },
  load(id) {
    if (id === entryId) return entry;
    return Option.getOrNull(
      Option.flatMap(packedModule(packages, id), ({ pkg, path }) =>
        Option.map(R.get(pkg.files, path), (code) => ({
          code,
          moduleSideEffects: pkg.manifest.sideEffects !== false,
        }))
      )
    );
  },
});

const gzipSize = (code: string): Effect.Effect<number, PromiseRejected> =>
  awaitPromise(() =>
    new Response(new Blob([code]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
  ).pipe(Effect.map((buffer) => buffer.byteLength));

const moduleName = (id: string): string =>
  id.startsWith(virtualPrefix)
    ? id.slice(virtualPrefix.length)
    : id.replace(/^.*\/node_modules\/effect\/dist\//, "effect/");

/**
 * A measurer over the packed packages: give it a consumer entry module (ESM
 * source importing the packages by name) and it answers that entry's bundle.
 * Packs each package once, up front.
 */
export const measurer = (
  packages: ReadonlyArray<WorkspacePackage>
): Effect.Effect<(entry: string) => Effect.Effect<BundleSize, PromiseRejected>, PromiseRejected> =>
  Effect.map(
    Effect.forEach(packages, pack, { concurrency: 1 }),
    (packed) => (entry: string) =>
      Effect.gen(function* () {
        const bundle = yield* awaitPromise(() =>
          rolldown({
            input: entryId,
            platform: "browser",
            logLevel: "silent",
            plugins: [packedPackages(packed, entry)],
          })
        );
        const { output } = yield* awaitPromise(() =>
          bundle.generate({ format: "esm", minify: true })
        );
        const chunk = output[0];
        return {
          gzip: yield* gzipSize(chunk.code),
          minified: chunk.code.length,
          modules: Arr.map(
            Arr.filter(R.toEntries(chunk.modules), ([, module]) => module.renderedLength > 0),
            ([id]) => moduleName(id)
          ),
        };
      })
  );
