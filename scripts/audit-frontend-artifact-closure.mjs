#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { parse } from "acorn";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE_SAMPLE_LIMIT = 50;
const RUNTIME_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class FailureCollector {
  constructor(limit = FAILURE_SAMPLE_LIMIT) {
    this.limit = limit;
    this.items = [];
    this.count = 0;
  }
  push(...messages) {
    for (const message of messages) {
      this.count += 1;
      if (this.items.length < this.limit) this.items.push(message);
    }
  }
}

export function formatFailures(failures, limit = FAILURE_SAMPLE_LIMIT, total = failures.length) {
  const lines = failures.slice(0, limit).map((failure) => `error: ${failure}`);
  if (total > Math.min(failures.length, limit)) {
    lines.push(`error: ${total - Math.min(failures.length, limit)} additional failures omitted`);
  }
  return lines;
}

function walk(root, predicate = () => true) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) queue.push(path.join(current, entry));
    } else if (stat.isFile() && predicate(current)) files.push(current);
  }
  return files.sort();
}

function inspectSymlinks(root, failures) {
  const queue = [root];
  let symlinkCount = 0;
  while (queue.length > 0) {
    const current = queue.pop();
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      symlinkCount += 1;
      try {
        const realpath = fs.realpathSync(current);
        if (!inside(realpath, root)) failures.push(`artifact symlink escapes root: ${path.relative(root, current)} -> ${realpath}`);
      } catch (error) {
        failures.push(`broken artifact symlink: ${path.relative(root, current)} (${error.message})`);
      }
      continue;
    }
    if (stat.isDirectory()) for (const entry of fs.readdirSync(current)) queue.push(path.join(current, entry));
  }
  return symlinkCount;
}

function commonArtifactChecks(root, contract, applicationRoots, appRoot, failures) {
  const entrypoints = contract.entrypoints ?? [];
  if (!Array.isArray(entrypoints) || entrypoints.length === 0) {
    failures.push("artifact.entrypoints must declare at least one runtime entrypoint");
  }
  for (const [index, entrypoint] of entrypoints.entries()) {
    const resolved = path.resolve(root, entrypoint);
    if (!inside(resolved, root)) failures.push(`artifact.entrypoints[${index}] escapes artifact`);
    else if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) failures.push(`runtime entrypoint is missing: ${entrypoint}`);
  }
  for (const siblingRoot of applicationRoots.filter((candidate) => path.normalize(candidate) !== path.normalize(appRoot))) {
    const candidate = path.resolve(root, siblingRoot);
    if (!inside(candidate, root)) {
      failures.push(`application root escapes artifact: ${siblingRoot}`);
    } else if (fs.existsSync(candidate)) {
      failures.push(`artifact contains sibling application root: ${siblingRoot}`);
    }
  }
}

export function auditNextStandaloneRoot(root, contract, applicationRoots = [], appRoot = "") {
  const canonicalRoot = fs.realpathSync(root);
  const failures = new FailureCollector();
  commonArtifactChecks(canonicalRoot, contract, applicationRoots, appRoot, failures);
  const traceRoots = contract.traceRoots ?? [];
  if (!Array.isArray(traceRoots) || traceRoots.length === 0) {
    failures.push("artifact.traceRoots must declare at least one Next trace root");
  }
  const manifests = [];
  for (const [index, traceRoot] of traceRoots.entries()) {
    const resolved = path.resolve(canonicalRoot, traceRoot);
    if (!inside(resolved, canonicalRoot)) {
      failures.push(`artifact.traceRoots[${index}] escapes artifact`);
      continue;
    }
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      failures.push(`Next trace root is missing: ${traceRoot}`);
      continue;
    }
    manifests.push(...walk(resolved, (file) => file.endsWith(".nft.json")));
  }
  if (manifests.length === 0) failures.push("no Next .nft.json trace manifests were found");
  let tracedFiles = 0;
  for (const manifestPath of [...new Set(manifests)].sort()) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      failures.push(`invalid trace manifest ${path.relative(canonicalRoot, manifestPath)}: ${error.message}`);
      continue;
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
      failures.push(`unsupported trace manifest ${path.relative(canonicalRoot, manifestPath)}`);
      continue;
    }
    for (const tracedFile of manifest.files) {
      tracedFiles += 1;
      if (typeof tracedFile !== "string" || !tracedFile) {
        failures.push(`${path.relative(canonicalRoot, manifestPath)} contains a non-path trace entry`);
        continue;
      }
      const resolved = path.resolve(path.dirname(manifestPath), tracedFile);
      if (!inside(resolved, canonicalRoot)) failures.push(`${path.relative(canonicalRoot, manifestPath)} trace escapes artifact: ${tracedFile}`);
      else if (!fs.existsSync(resolved)) failures.push(`${path.relative(canonicalRoot, manifestPath)} traced dependency is missing: ${tracedFile}`);
      else if (!inside(fs.realpathSync(resolved), canonicalRoot)) failures.push(`${path.relative(canonicalRoot, manifestPath)} traced dependency resolves outside artifact: ${tracedFile}`);
    }
  }
  const symlinkCount = inspectSymlinks(canonicalRoot, failures);
  return result("nextjs-standalone", canonicalRoot, failures, { traceManifests: new Set(manifests).size, tracedFiles, symlinkCount });
}

export function auditTanstackArtifactRoot(root, contract, applicationRoots = [], appRoot = "") {
  const canonicalRoot = fs.realpathSync(root);
  const failures = new FailureCollector();
  commonArtifactChecks(canonicalRoot, contract, applicationRoots, appRoot, failures);
  const symlinkCount = inspectSymlinks(canonicalRoot, failures);
  const allFiles = walk(canonicalRoot);
  const relativeFiles = allFiles.map((file) => path.relative(canonicalRoot, file).split(path.sep).join("/"));
  for (const relative of relativeFiles) {
    if (relative === "apps/web" || relative.startsWith("apps/web/")) failures.push(`Web application leaked into Admin artifact: ${relative}`);
    if (/(^|\/)src(\/|$)/u.test(relative)) failures.push(`source directory is present in runtime artifact: ${relative}`);
    if (/\.(?:ts|tsx|cts|mts|d\.ts|map)$/u.test(relative)) failures.push(`source or source map is present in runtime artifact: ${relative}`);
  }
  for (const packageName of contract.forbiddenPackages ?? []) {
    const candidate = path.join(canonicalRoot, "node_modules", ...packageName.split("/"));
    if (fs.existsSync(candidate)) failures.push(`build-only package is present in runtime artifact: ${packageName}`);
  }
  for (const file of allFiles.filter((candidate) => /\.(?:cjs|js|json|mjs)$/u.test(candidate))) {
    const source = fs.readFileSync(file, "utf8");
    for (const fingerprint of contract.forbiddenFingerprints ?? []) {
      if (source.includes(fingerprint)) failures.push(`build-only fingerprint is present: ${fingerprint} (${path.relative(canonicalRoot, file)})`);
    }
  }
  verifyArtifactManifest(canonicalRoot, relativeFiles, failures);
  verifyImportClosure(canonicalRoot, allFiles, failures);
  return result("tanstack-start-filtered", canonicalRoot, failures, {
    files: allFiles.length,
    symlinkCount,
    traceManifests: 0,
    tracedFiles: 0,
  });
}

function verifyArtifactManifest(root, relativeFiles, failures) {
  const manifestPath = path.join(root, "artifact-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`runtime artifact manifest is missing or invalid: ${error.message}`);
    return;
  }
  if (manifest.schema !== "friday-relay.frontend-runtime-artifact.v1") failures.push("runtime artifact manifest schema is invalid");
  if (manifest.runtime !== "bun-1.4.0") failures.push("runtime artifact is not bound to Bun 1.4.0");
  const declared = new Map((manifest.files ?? []).map((entry) => [entry.path, entry]));
  const actual = relativeFiles.filter((entry) => entry !== "artifact-manifest.json");
  for (const relative of actual) {
    const entry = declared.get(relative);
    if (!entry) {
      failures.push(`runtime artifact file is absent from manifest: ${relative}`);
      continue;
    }
    const bytes = fs.readFileSync(path.join(root, relative));
    if (entry.size !== bytes.byteLength || entry.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      failures.push(`runtime artifact manifest digest differs: ${relative}`);
    }
  }
  for (const relative of declared.keys()) if (!actual.includes(relative)) failures.push(`runtime artifact manifest references missing file: ${relative}`);
}

export function scanRuntimeImports(source) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const imports = new Map();
  visit(ast, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      add("import-statement", literalSpecifier(node.source));
      return;
    }
    if (node.type === "ImportExpression") {
      add("dynamic-import", literalSpecifier(node.source));
      return;
    }
    if (node.type !== "CallExpression") return;
    if (node.callee?.type === "Identifier" && node.callee.name === "require") {
      add("require-call", literalSpecifier(node.arguments?.[0]));
      return;
    }
    if (memberCall(node.callee, "require", "resolve")) {
      add("require-resolve", literalSpecifier(node.arguments?.[0]));
      return;
    }
    if (memberCall(node.callee, "module", "require")) {
      add("module-require", literalSpecifier(node.arguments?.[0]));
    }
  });
  return [...imports.values()];

  function add(kind, specifier) {
    if (specifier !== null) imports.set(`${kind}\0${specifier}`, { kind, path: specifier });
  }
}

function verifyImportClosure(root, files, failures) {
  for (const file of files.filter((candidate) => /\.(?:cjs|js|mjs)$/u.test(candidate))) {
    let imports;
    try {
      imports = scanRuntimeImports(fs.readFileSync(file, "utf8"));
    } catch (error) {
      failures.push(`runtime module cannot be parsed: ${path.relative(root, file)} (${error.message})`);
      continue;
    }
    for (const imported of imports) {
      const specifier = imported.path;
      if (specifier === "bun" || specifier.startsWith("bun:") || RUNTIME_BUILTINS.has(specifier)) continue;
      try {
        const resolvedValue = imported.kind === "require-call"
          || imported.kind === "require-resolve"
          || imported.kind === "module-require"
          ? createRequire(file).resolve(specifier)
          : typeof Bun !== "undefined"
            ? Bun.resolveSync(specifier, path.dirname(file))
            : createRequire(file).resolve(specifier);
        const resolved = fs.realpathSync(resolvedValue);
        if (!inside(resolved, root)) failures.push(`runtime import escapes artifact: ${specifier} (${path.relative(root, file)})`);
      } catch {
        failures.push(`runtime import cannot resolve: ${specifier} (${path.relative(root, file)})`);
      }
    }
  }
}

function visit(node, inspect) {
  if (!node || typeof node !== "object") return;
  inspect(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inspect);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      visit(value, inspect);
    }
  }
}

function literalSpecifier(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? null;
  return null;
}

function memberCall(node, objectName, propertyName) {
  return node?.type === "MemberExpression"
    && !node.computed
    && node.object?.type === "Identifier"
    && node.object.name === objectName
    && node.property?.type === "Identifier"
    && node.property.name === propertyName;
}

function result(kind, root, failures, extra) {
  return {
    schema: "frontend-artifact-closure-audit.v1",
    kind,
    status: failures.count === 0 ? "passed" : "failed",
    artifactRoot: root,
    ...extra,
    failureCount: failures.count,
    failures: failures.items,
    omittedFailures: failures.count - failures.items.length,
  };
}

export function loadArtifactContract(manifestPath, appId, artifactRootOverride = "") {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absoluteManifest, "utf8"));
  if (manifest.schema !== "frontend-build-contracts.v1") throw new Error("manifest schema must be frontend-build-contracts.v1");
  const app = (manifest.apps ?? []).find((candidate) => candidate.id === appId);
  if (!app) throw new Error(`app not found in manifest: ${appId}`);
  if (!app.artifact || typeof app.artifact.root !== "string") throw new Error(`${appId}.artifact.root is required`);
  const workspaceRoot = path.resolve(path.dirname(absoluteManifest), manifest.workspaceRoot ?? ".");
  const artifactRoot = artifactRootOverride ? path.resolve(artifactRootOverride) : path.resolve(workspaceRoot, app.artifact.root);
  if (!fs.statSync(artifactRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`artifact root does not exist: ${artifactRoot}`);
  return { manifest, app, artifactRoot };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { manifest, app, artifactRoot } = loadArtifactContract(
      options.manifest,
      options.app,
      options.artifactRoot,
    );
    const resultValue = app.artifact.kind === "nextjs-standalone"
      ? auditNextStandaloneRoot(artifactRoot, app.artifact, manifest.applicationRoots, app.root)
      : app.artifact.kind === "tanstack-start-filtered"
        ? auditTanstackArtifactRoot(artifactRoot, app.artifact, manifest.applicationRoots, app.root)
        : (() => { throw new Error(`unsupported artifact kind: ${app.artifact.kind}`); })();
    if (options.json) console.log(JSON.stringify(resultValue, null, 2));
    else {
      console.log(`${resultValue.status}: ${options.app} (${resultValue.kind})`);
      for (const line of formatFailures(resultValue.failures, FAILURE_SAMPLE_LIMIT, resultValue.failureCount)) console.error(line);
    }
    return resultValue.status === "passed" ? 0 : 1;
  } catch (error) {
    const output = { schema: "frontend-artifact-closure-audit.v1", status: "failed", reason: "contract_error", error: error.message };
    if (process.argv.includes("--json")) console.log(JSON.stringify(output, null, 2));
    else console.error(`error: ${error.message}`);
    return 2;
  }
}

function parseArgs(argv) {
  const options = { manifest: "", app: "", artifactRoot: "", workspaceRoot: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") options.manifest = argv[++index] ?? "";
    else if (arg === "--app") options.app = argv[++index] ?? "";
    else if (arg === "--artifact-root") options.artifactRoot = argv[++index] ?? "";
    else if (arg === "--workspace-root") options.workspaceRoot = argv[++index] ?? "";
    else if (arg === "--json") options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.manifest || !options.app) throw new Error("--manifest and --app are required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
