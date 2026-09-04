#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFrontendBuildContract, inside } from "./frontend-build-contract-lib.mjs";

const options = parseArgs(process.argv.slice(2));
const { app, workspaceRoot } = loadFrontendBuildContract(
  options.manifest,
  options.app,
  options.workspaceRoot,
);
if (app.framework !== "tanstack-start" || app.artifact?.kind !== "tanstack-start-filtered") {
  throw new Error(`${app.id}: filtered TanStack Start artifact contract is required`);
}
if (typeof Bun === "undefined") throw new Error("Bun runtime is required to build the filtered artifact");

const sourceRoot = resolveContractPath(app.artifact.sourceRoot, "artifact.sourceRoot", true);
const artifactRoot = resolveContractPath(app.artifact.root, "artifact.root", false);
if (sourceRoot === artifactRoot || inside(sourceRoot, artifactRoot) || inside(artifactRoot, sourceRoot)) {
  throw new Error(`${app.id}: artifact source and destination roots must not overlap`);
}
const serverRoot = path.join(artifactRoot, app.artifact.serverRoot);
const clientRoot = path.join(artifactRoot, app.artifact.clientRoot);
const nodeModulesRoot = path.join(artifactRoot, "node_modules");
const runtimeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const commonJsImportKinds = new Set(["require-call"]);
const esmImportKinds = new Set(["import-statement", "dynamic-import"]);
const supportedImportKinds = new Set([...commonJsImportKinds, ...esmImportKinds]);
const forbiddenPackages = app.artifact.forbiddenPackages ?? [];
const bunIsolatedDependencyRoot = path.join(workspaceRoot, "node_modules", ".bun", "node_modules");
const stableCommonJsAnchors = [
  path.join(workspaceRoot, "package.json"),
  path.join(bunIsolatedDependencyRoot, ".friday-relay-commonjs-resolver.cjs"),
];

if (options.verifyExistingArtifact) {
  await verifyArtifactImportClosure();
  await verifyForbiddenContent();
  console.log(`${app.id}: filtered runtime artifact closure verified`);
  process.exit(0);
}

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });
await cp(path.join(sourceRoot, app.artifact.serverRoot), serverRoot, { recursive: true, force: true });
await cp(path.join(sourceRoot, app.artifact.clientRoot), clientRoot, { recursive: true, force: true });

const launcherSource = resolveContractPath(app.artifact.launcherSource, "artifact.launcherSource", true);
await cp(launcherSource, path.join(artifactRoot, "serve.mjs"), { force: true });

for (const [index, include] of (app.artifact.runtimeIncludes ?? []).entries()) {
  const source = resolveContractPath(include.source, `artifact.runtimeIncludes[${index}].source`, true);
  const destination = resolveArtifactPath(include.destination, `artifact.runtimeIncludes[${index}].destination`);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

const sourceServerEntry = path.join(artifactRoot, app.artifact.sourceServerEntry);
await assertFile(sourceServerEntry, "source server entry");
const sourceQueue = [
  ...(await listFiles(serverRoot)).filter(isTraceableModule),
  path.join(artifactRoot, "serve.mjs"),
];
const visitedSources = new Set();
const packageRoots = new Map();
const packageVersions = new Map();
const externalSpecifiers = new Set();

while (sourceQueue.length > 0) {
  const sourceFile = sourceQueue.shift();
  if (!sourceFile) break;
  const canonicalSource = await realpath(sourceFile);
  if (visitedSources.has(canonicalSource)) continue;
  visitedSources.add(canonicalSource);
  const source = await readFile(canonicalSource, "utf8");
  for (const imported of parseModuleImports(source)) {
    const { kind, path: specifier } = imported;
    if (isRuntimeBuiltin(specifier)) continue;
    if (specifier.startsWith("#")) {
      throw new Error(`${app.id}: unresolved package-internal import ${specifier} from ${canonicalSource}`);
    }
    const resolved = await resolveImport(specifier, canonicalSource, kind);
    if (isBareSpecifier(specifier)) {
      externalSpecifiers.add(specifier);
      const packageInfo = await packageForFile(resolved);
      await registerPackage(packageInfo);
      await copyPackageFile(packageInfo, resolved);
    } else {
      for (const [name, root] of packageRoots) {
        if (inside(resolved, root)) {
          await copyPackageFile({ name, root, version: packageVersions.get(name) }, resolved);
          break;
        }
      }
    }
    if (isTraceableModule(resolved)) sourceQueue.push(resolved);
  }
}

const externalPackages = [...packageRoots.keys()].sort();
for (const required of app.artifact.requiredPackages ?? []) {
  if (!externalPackages.includes(required)) {
    throw new Error(`${app.id}: required runtime package is absent from artifact closure: ${required}`);
  }
}

await writeFile(
  path.join(artifactRoot, "package.json"),
  `${JSON.stringify({
    name: `friday-relay-${app.id}-runtime-artifact`,
    private: true,
    type: "module",
    dependencies: Object.fromEntries(externalPackages.map((name) => [name, packageVersions.get(name)])),
  }, null, 2)}\n`,
  { mode: 0o644 },
);

verifyArtifactInFreshProcess();

const artifactFiles = (await listFiles(artifactRoot))
  .filter((file) => path.basename(file) !== "artifact-manifest.json")
  .sort();
const files = [];
for (const file of artifactFiles) {
  const bytes = await readFile(file);
  files.push({ path: relativeArtifactPath(file), sha256: sha256(bytes), size: bytes.byteLength });
}
const manifest = {
  schema: "friday-relay.frontend-runtime-artifact.v1",
  app: app.id,
  framework: app.framework,
  runtime: "bun-1.4.0",
  closure: {
    externalPackages,
    externalSpecifiers: [...externalSpecifiers].sort(),
    entrypoints: app.artifact.entrypoints,
  },
  files,
};
await writeFile(
  path.join(artifactRoot, "artifact-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(JSON.stringify({
  schema: manifest.schema,
  app: app.id,
  artifact: artifactRoot,
  files: files.length,
  externalPackages,
}));

async function registerPackage(packageInfo) {
  const existing = packageRoots.get(packageInfo.name);
  if (existing && existing !== packageInfo.root) {
    throw new Error(`${app.id}: runtime package resolves from multiple roots: ${packageInfo.name}`);
  }
  if (existing) return;
  packageRoots.set(packageInfo.name, packageInfo.root);
  packageVersions.set(packageInfo.name, packageInfo.version);
  const destination = path.join(nodeModulesRoot, ...packageInfo.name.split("/"));
  await mkdir(destination, { recursive: true });
  await cp(path.join(packageInfo.root, "package.json"), path.join(destination, "package.json"));
}

async function copyPackageFile(packageInfo, sourceFile) {
  const relative = path.relative(packageInfo.root, sourceFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${app.id}: runtime package file escapes ${packageInfo.name}: ${sourceFile}`);
  }
  const destination = path.join(nodeModulesRoot, ...packageInfo.name.split("/"), relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourceFile, destination, { force: true });
}

async function packageForFile(file) {
  let current = path.dirname(await realpath(file));
  while (true) {
    const candidate = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      if (typeof parsed.name === "string") {
        return { name: parsed.name, root: current, version: parsed.version ?? "0.0.0" };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`${app.id}: package root not found for ${file}`);
    current = parent;
  }
}

async function resolveImport(specifier, importer, kind) {
  if (commonJsImportKinds.has(kind)) {
    const anchors = isBareSpecifier(specifier) && inside(path.resolve(importer), artifactRoot)
      ? stableCommonJsAnchors
      : [importer];
    for (const anchor of anchors) {
      try {
        return await realpath(createRequire(anchor).resolve(specifier));
      } catch {
        // Continue to the stable closure error.
      }
    }
    throw new Error(`${app.id}: runtime CommonJS import cannot resolve: ${specifier} from ${importer}`);
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/") ? specifier : path.resolve(path.dirname(importer), specifier);
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}.node`]) {
      try {
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  const resolutionBases = inside(path.resolve(importer), artifactRoot)
    ? [workspaceRoot, bunIsolatedDependencyRoot]
    : [path.dirname(importer), workspaceRoot, bunIsolatedDependencyRoot];
  for (const base of resolutionBases) {
    try {
      return await realpath(Bun.resolveSync(specifier, base));
    } catch {
      // Continue to the stable closure error.
    }
  }
  throw new Error(`${app.id}: runtime import cannot resolve: ${specifier} from ${importer}`);
}

function verifyArtifactInFreshProcess() {
  const result = spawnSync(process.execPath, [
    fileURLToPath(import.meta.url),
    "--manifest",
    path.resolve(options.manifest),
    "--app",
    app.id,
    "--workspace-root",
    workspaceRoot,
    "--verify-existing-artifact",
  ], { cwd: workspaceRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${app.id}: filtered runtime artifact verification failed (${result.status})`);
  }
}

async function verifyArtifactImportClosure() {
  const canonicalArtifactRoot = await realpath(artifactRoot);
  for (const file of (await listFiles(artifactRoot)).filter(isTraceableModule)) {
    const source = await readFile(file, "utf8");
    for (const imported of parseModuleImports(source)) {
      const { kind, path: specifier } = imported;
      if (isRuntimeBuiltin(specifier)) continue;
      let resolved;
      try {
        const resolvedValue = kind === "require-call"
          ? createRequire(file).resolve(specifier)
          : Bun.resolveSync(specifier, path.dirname(file));
        resolved = await realpath(resolvedValue);
      } catch {
        throw new Error(`${app.id}: artifact import cannot resolve: ${specifier} from ${relativeArtifactPath(file)}`);
      }
      if (!inside(resolved, canonicalArtifactRoot)) {
        throw new Error(`${app.id}: artifact import escapes runtime root: ${specifier} -> ${resolved}`);
      }
    }
  }
}

async function verifyForbiddenContent() {
  const files = await listFiles(artifactRoot);
  for (const file of files) {
    const relative = relativeArtifactPath(file);
    if (relative === "apps/web" || relative.startsWith("apps/web/")) {
      throw new Error(`${app.id}: Web application leaked into Admin artifact: ${relative}`);
    }
    if (/(^|\/)src(\/|$)/u.test(relative)) throw new Error(`${app.id}: source directory in runtime artifact: ${relative}`);
    if (/\.(?:ts|tsx|cts|mts|d\.ts|map)$/u.test(relative)) {
      throw new Error(`${app.id}: source or source map in runtime artifact: ${relative}`);
    }
  }
  for (const packageName of forbiddenPackages) {
    const candidate = path.join(nodeModulesRoot, ...packageName.split("/"));
    try {
      await lstat(candidate);
      throw new Error(`${app.id}: build-only package in runtime artifact: ${packageName}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const file of files.filter((candidate) => isTraceableModule(candidate) || candidate.endsWith(".json"))) {
    const source = await readFile(file, "utf8");
    for (const fingerprint of app.artifact.forbiddenFingerprints ?? []) {
      if (source.includes(fingerprint)) {
        throw new Error(`${app.id}: build-only fingerprint in runtime artifact: ${fingerprint} (${relativeArtifactPath(file)})`);
      }
    }
  }
}

function parseModuleImports(source) {
  const imports = new Map();
  for (const entry of new Bun.Transpiler({ loader: "js" }).scanImports(source)) {
    if (!supportedImportKinds.has(entry.kind)) {
      throw new Error(`${app.id}: unsupported runtime import kind: ${entry.kind}`);
    }
    imports.set(`${entry.kind}\0${entry.path}`, { kind: entry.kind, path: entry.path });
  }
  return imports.values();
}

async function listFiles(root) {
  const output = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) output.push(candidate);
      else throw new Error(`${app.id}: special file is forbidden in artifact: ${candidate}`);
    }
  }
  await visit(root);
  return output;
}

function resolveContractPath(value, field, mustExist) {
  if (typeof value !== "string" || !value) throw new Error(`${app.id}.${field} is required`);
  const resolved = path.resolve(workspaceRoot, value);
  if (!inside(resolved, workspaceRoot)) throw new Error(`${app.id}.${field} escapes workspace root`);
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`${app.id}.${field} is missing: ${value}`);
  return resolved;
}

function resolveArtifactPath(value, field) {
  if (typeof value !== "string" || !value) throw new Error(`${app.id}.${field} is required`);
  const resolved = path.resolve(artifactRoot, value);
  if (!inside(resolved, artifactRoot)) throw new Error(`${app.id}.${field} escapes artifact root`);
  return resolved;
}

function relativeArtifactPath(file) {
  return path.relative(artifactRoot, file).split(path.sep).join("/");
}

function isRuntimeBuiltin(specifier) {
  return runtimeBuiltins.has(specifier) || specifier.startsWith("bun:") || specifier === "bun";
}

function isBareSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function isTraceableModule(file) {
  return /\.(?:cjs|js|mjs)$/u.test(file);
}

async function assertFile(file, label) {
  if (!(await stat(file)).isFile()) throw new Error(`${app.id}: ${label} is missing: ${file}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const result = {
    manifest: "ops/build/frontend-build-contracts.json",
    app: "admin",
    workspaceRoot: "",
    verifyExistingArtifact: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") result.manifest = argv[++index] ?? "";
    else if (arg === "--app") result.app = argv[++index] ?? "";
    else if (arg === "--workspace-root") result.workspaceRoot = argv[++index] ?? "";
    else if (arg === "--verify-existing-artifact") result.verifyExistingArtifact = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.manifest || !result.app) throw new Error("--manifest and --app are required");
  return result;
}
