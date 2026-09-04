#!/usr/bin/env node

import { createRequire, builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatSourceBlocker,
  loadFrontendBuildContract,
  sourcePrerequisiteBlockers,
} from "./frontend-build-contract-lib.mjs";
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RUNTIME_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const RUNTIME_SCAN_IGNORES = new Set([
  ".git", ".next", ".turbo", "__tests__", "coverage", "dist", "node_modules", "test", "tests",
]);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export class ContractError extends Error {}

function parseArgs(argv) {
  const options = { manifest: "", app: "", workspaceRoot: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") options.manifest = argv[++index] ?? "";
    else if (arg === "--app") options.app = argv[++index] ?? "";
    else if (arg === "--workspace-root") options.workspaceRoot = argv[++index] ?? "";
    else if (arg === "--json") options.json = true;
    else throw new ContractError(`unknown argument: ${arg}`);
  }
  if (!options.manifest) throw new ContractError("--manifest is required");
  if (!options.app) throw new ContractError("--app is required");
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ContractError(`cannot read JSON ${file}: ${error.message}`);
  }
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findRepoRoot(start) {
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) throw new ContractError("manifest is not inside a Git repository");
  }
}

function resolveInside(root, value, field, { mustExist = true } = {}) {
  if (typeof value !== "string" || !value) throw new ContractError(`${field} must be a non-empty path`);
  const resolved = path.resolve(root, value);
  if (!inside(resolved, root)) throw new ContractError(`${field} escapes the workspace root`);
  if (mustExist && !fs.existsSync(resolved)) throw new ContractError(`${field} does not exist: ${resolved}`);
  return resolved;
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function exportSpecifier(packageName, exportName) {
  if (exportName === ".") return packageName;
  if (!exportName.startsWith("./")) throw new ContractError(`invalid package export key: ${exportName}`);
  return `${packageName}/${exportName.slice(2)}`;
}

function sourceCandidate(base) {
  const extensionAliases = {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"],
  };
  const requestedExtension = path.extname(base);
  if (extensionAliases[requestedExtension]) {
    const withoutExtension = base.slice(0, -requestedExtension.length);
    for (const extension of extensionAliases[requestedExtension]) {
      const candidate = `${withoutExtension}${extension}`;
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(base, `index${extension}`);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  return null;
}

function importSpecifiers(source) {
  const results = [];
  const patterns = [
    /(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[^"'\n;]*?\sfrom\s*)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) results.push(match[1]);
  }
  return [...new Set(results)];
}

function walkRuntimeSources(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (!RUNTIME_SCAN_IGNORES.has(entry)) queue.push(path.join(current, entry));
      }
    } else if (stat.isFile() && RUNTIME_SOURCE_EXTENSIONS.has(path.extname(current)) &&
      !/\.(?:spec|test)\.[^.]+$/.test(path.basename(current))) {
      files.push(current);
    }
  }
  return files.sort();
}

function resolveSourceImport(sourceFile, specifier) {
  if (specifier.startsWith(".")) return sourceCandidate(path.resolve(path.dirname(sourceFile), specifier));
  if (path.isAbsolute(specifier)) return sourceCandidate(specifier);
  if (specifier.startsWith("file:")) {
    try {
      return sourceCandidate(fileURLToPath(specifier));
    } catch {
      return null;
    }
  }
  return null;
}

function inferApplicationRoots(manifest, workspaceRoot, appRoot, failures) {
  const declared = manifest.applicationRoots;
  const roots = [];
  if (declared !== undefined && (!Array.isArray(declared) || declared.length === 0)) {
    failures.push("applicationRoots must be a non-empty array when declared");
    return roots;
  }
  const candidates = declared ?? fs.readdirSync(path.dirname(appRoot))
    .map((entry) => path.join(path.dirname(appRoot), entry))
    .filter((candidate) => fs.statSync(path.join(candidate, "package.json"), { throwIfNoEntry: false })?.isFile())
    .map((candidate) => path.relative(workspaceRoot, candidate));
  for (const [index, candidate] of candidates.entries()) {
    try {
      const root = resolveInside(workspaceRoot, candidate, `applicationRoots[${index}]`);
      if (!fs.statSync(path.join(root, "package.json"), { throwIfNoEntry: false })?.isFile()) {
        failures.push(`applicationRoots[${index}] has no package.json: ${candidate}`);
        continue;
      }
      if (!roots.some((existing) => fs.realpathSync(existing) === fs.realpathSync(root))) roots.push(root);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (!roots.some((root) => fs.realpathSync(root) === fs.realpathSync(appRoot))) {
    failures.push("applicationRoots must include the audited app root");
  }
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const leftRoot = fs.realpathSync(roots[left]);
      const rightRoot = fs.realpathSync(roots[right]);
      if (inside(leftRoot, rightRoot) || inside(rightRoot, leftRoot)) {
        failures.push(`applicationRoots must not overlap: ${path.relative(workspaceRoot, roots[left])} and ${path.relative(workspaceRoot, roots[right])}`);
      }
    }
  }
  return roots;
}

function inspectRuntimeApplicationBoundary(manifest, app, workspaceRoot, appRoot, failures) {
  const applicationRoots = inferApplicationRoots(manifest, workspaceRoot, appRoot, failures);
  const canonicalAppRoot = fs.realpathSync(appRoot);
  const siblings = applicationRoots
    .filter((root) => fs.realpathSync(root) !== canonicalAppRoot)
    .map((root) => {
      const packageJson = readJson(path.join(root, "package.json"));
      return { root, canonicalRoot: fs.realpathSync(root), packageName: packageJson.name };
    });
  const violations = [];
  const sourceFiles = walkRuntimeSources(appRoot);
  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const barePackage = specifier.startsWith(".") || path.isAbsolute(specifier) || specifier.startsWith("file:")
        ? null
        : packageNameFromSpecifier(specifier);
      const resolved = resolveSourceImport(sourceFile, specifier);
      const canonicalTarget = resolved && fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
      const sibling = siblings.find((candidate) =>
        (canonicalTarget && inside(canonicalTarget, candidate.canonicalRoot)) ||
        (candidate.packageName && barePackage === candidate.packageName)
      );
      if (!sibling) continue;
      const detail = `${path.relative(workspaceRoot, sourceFile)} imports ${JSON.stringify(specifier)} from sibling application ${path.relative(workspaceRoot, sibling.root)}`;
      failures.push(`${app.id}: runtime application boundary violation: ${detail}`);
      violations.push(detail);
    }
  }
  return {
    mode: manifest.applicationRoots ? "declared" : "inferred-siblings",
    applicationRoots: applicationRoots.map((root) => path.relative(workspaceRoot, root)),
    scannedFiles: sourceFiles.length,
    violations,
  };
}

export function scanEntrypoint(entrypoint, packageRoot) {
  const canonicalRoot = fs.realpathSync(packageRoot);
  const visited = new Set();
  const signals = new Set();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const current = fs.realpathSync(queue.pop());
    if (visited.has(current)) continue;
    if (!inside(current, canonicalRoot)) continue;
    visited.add(current);
    const source = fs.readFileSync(current, "utf8");
    if (/^\s*["']use client["'];?/m.test(source)) signals.add("client");
    for (const specifier of importSpecifiers(source)) {
      if (specifier === "server-only") signals.add("server");
      if (specifier === "next/navigation") signals.add("client");
      if (BUILTINS.has(specifier)) signals.add("server");
      if (!specifier.startsWith(".")) continue;
      const candidate = sourceCandidate(path.resolve(path.dirname(current), specifier));
      if (candidate) queue.push(candidate);
    }
  }
  return { files: [...visited].sort(), signals: [...signals].sort() };
}

function validateEvidenceException(app, workspaceRoot, id, failures) {
  const exception = app.evidenceExceptions?.[id];
  if (!exception || typeof exception !== "object") {
    failures.push(`${app.id}: ${id} requires measured evidence; no evidenceExceptions.${id} was declared`);
    return;
  }
  let evidenceFile;
  try {
    evidenceFile = resolveInside(workspaceRoot, exception.evidenceFile, `${app.id}.evidenceExceptions.${id}.evidenceFile`);
  } catch (error) {
    failures.push(error.message);
    return;
  }
  if (typeof exception.requiredText !== "string" || !exception.requiredText) {
    failures.push(`${app.id}: evidenceExceptions.${id}.requiredText must be non-empty`);
    return;
  }
  if (!fs.readFileSync(evidenceFile, "utf8").includes(exception.requiredText)) {
    failures.push(`${app.id}: evidence for ${id} is missing required marker ${JSON.stringify(exception.requiredText)}`);
  }
}

function inspectPolicyFiles(app, workspaceRoot, failures) {
  const text = (app.policyFiles ?? []).map((file, index) => {
    const resolved = resolveInside(workspaceRoot, file, `${app.id}.policyFiles[${index}]`);
    return `${resolved}\n${fs.readFileSync(resolved, "utf8")}`;
  }).join("\n");
  if (/resolve\s*\.\s*symlinks\s*=\s*false|symlinks\s*:\s*false/.test(text)) {
    validateEvidenceException(app, workspaceRoot, "resolveSymlinksFalse", failures);
  }
  if (/optimizePackageImports\s*:/.test(text)) {
    validateEvidenceException(app, workspaceRoot, "optimizePackageImports", failures);
  }
  const memory = app.memory;
  if (!memory || !Number.isInteger(memory.containerLimitMiB) || memory.containerLimitMiB <= 0) {
    failures.push(`${app.id}: memory.containerLimitMiB must be a positive integer`);
    return;
  }
  if (memory.heapLimitMiB !== undefined && (!Number.isInteger(memory.heapLimitMiB) || memory.heapLimitMiB <= 0)) {
    failures.push(`${app.id}: memory.heapLimitMiB must be a positive integer when declared`);
  }
  if (memory.baselineHeapLimitMiB !== undefined &&
      (!Number.isInteger(memory.baselineHeapLimitMiB) || memory.baselineHeapLimitMiB <= 0)) {
    failures.push(`${app.id}: memory.baselineHeapLimitMiB must be a positive integer when declared`);
  }
  if (Number.isInteger(memory.heapLimitMiB) && memory.heapLimitMiB > memory.containerLimitMiB) {
    failures.push(`${app.id}: heapLimitMiB ${memory.heapLimitMiB} exceeds the ${memory.containerLimitMiB} MiB container gate`);
  }
  if (Number.isInteger(memory.heapLimitMiB) && Number.isInteger(memory.baselineHeapLimitMiB) &&
      memory.heapLimitMiB > memory.baselineHeapLimitMiB) {
    validateEvidenceException(app, workspaceRoot, "heapIncrease", failures);
  }
}

function findLexicalPackage(appRoot, workspaceRoot, packageName) {
  for (const nodeModules of [path.join(appRoot, "node_modules"), path.join(workspaceRoot, "node_modules")]) {
    const candidate = path.join(nodeModules, ...packageName.split("/"));
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })) return candidate;
  }
  return null;
}

function normalizeConfig(configExport) {
  if (typeof configExport === "function") return configExport("phase-production-build", { defaultConfig: {} });
  return configExport;
}

async function callExternalFunction(external, request, appRoot) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    try {
      const returned = external({ context: appRoot, request, dependencyType: "esm" }, finish);
      if (returned && typeof returned.then === "function") returned.then((value) => finish(null, value), finish);
      else if (returned !== undefined) finish(null, returned);
      else queueMicrotask(() => {
        if (!settled) finish(null, undefined);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function externalMatches(external, request, appRoot) {
  if (typeof external === "function") return (await callExternalFunction(external, request, appRoot)) !== undefined;
  if (typeof external === "string") return external === request;
  if (external instanceof RegExp) return external.test(request);
  if (Array.isArray(external)) {
    for (const item of external) if (await externalMatches(item, request, appRoot)) return true;
    return false;
  }
  return Boolean(external && typeof external === "object" && Object.hasOwn(external, request));
}

async function inspectNextConfig(app, workspaceRoot, appRoot, packageContracts, failures) {
  const nextConfigPath = resolveInside(workspaceRoot, app.frameworkConfig?.path, `${app.id}.frameworkConfig.path`);
  let config;
  try {
    const imported = await import(`${pathToFileURL(nextConfigPath).href}?contract-audit=${Date.now()}`);
    config = await normalizeConfig(imported.default ?? imported);
  } catch (error) {
    failures.push(`${app.id}: cannot evaluate Next config: ${error.message}`);
    return { detected: [] };
  }
  if (!config || typeof config !== "object") {
    failures.push(`${app.id}: Next config did not evaluate to an object`);
    return { detected: [] };
  }

  let externals = [];
  if (typeof config.webpack === "function") {
    try {
      const webpackConfig = await config.webpack(
        { externals: [], resolve: {} },
        { buildId: "contract-audit", dev: false, dir: appRoot, isServer: true, nextRuntime: "nodejs", webpack: {} },
      );
      externals = webpackConfig?.externals ?? [];
    } catch (error) {
      failures.push(`${app.id}: cannot evaluate server webpack config: ${error.message}`);
    }
  }
  if (!Array.isArray(externals)) externals = [externals];
  const standard = new Set(config.serverExternalPackages ?? []);
  const allowed = Array.isArray(app.allowedExternalPackages) ? app.allowedExternalPackages : [];
  const allowedSpecifiers = new Set(allowed.map((entry) => entry.specifier));
  const probes = new Set([...standard, ...allowedSpecifiers]);
  for (const contract of packageContracts.values()) {
    probes.add(contract.name);
    probes.add(`${contract.name}/__next_boundary_probe__`);
    for (const entrypoint of contract.entrypoints) probes.add(exportSpecifier(contract.name, entrypoint.export));
  }
  const detected = new Set(standard);
  for (const request of probes) {
    try {
      if (await externalMatches(externals, request, appRoot)) detected.add(request);
    } catch (error) {
      failures.push(`${app.id}: webpack external probe for ${request} failed: ${error.message}`);
    }
  }

  for (const specifier of detected) {
    const packageName = packageNameFromSpecifier(specifier);
    const contract = packageContracts.get(packageName);
    const wholePackage = specifier === packageName || detected.has(`${packageName}/__next_boundary_probe__`);
    if (!allowedSpecifiers.has(specifier) && !(wholePackage && allowedSpecifiers.has(packageName))) {
      failures.push(`${app.id}: ${specifier} is externalized but not admitted by allowedExternalPackages`);
    }
    if (!contract) continue;
    if (wholePackage && contract.classification !== "server") {
      failures.push(`${app.id}: whole-package externalization is forbidden for ${contract.classification} package ${packageName}`);
      continue;
    }
    if (!wholePackage) {
      const entrypoint = contract.entrypoints.find((entry) => exportSpecifier(packageName, entry.export) === specifier);
      if (!entrypoint || entrypoint.surface !== "server") {
        failures.push(`${app.id}: externalized subpath ${specifier} is not a declared server entrypoint`);
      }
    }
  }
  for (const entry of allowed) {
    if (!entry || typeof entry.specifier !== "string" || !entry.specifier) {
      failures.push(`${app.id}: every allowedExternalPackages entry requires specifier`);
      continue;
    }
    const packageName = packageNameFromSpecifier(entry.specifier);
    const used = detected.has(entry.specifier) || detected.has(packageName) || detected.has(`${packageName}/__next_boundary_probe__`);
    if (!used) failures.push(`${app.id}: admitted external ${entry.specifier} was not detected in the production Next config`);
  }
  return { detected: [...detected].sort() };
}

function inspectTanstackConfig(app, workspaceRoot, appRoot, failures) {
  const configPath = resolveInside(workspaceRoot, app.frameworkConfig?.path, `${app.id}.frameworkConfig.path`);
  const packageJson = readJson(path.join(appRoot, "package.json"));
  const dependencies = { ...packageJson.dependencies, ...packageJson.optionalDependencies };
  const devDependencies = packageJson.devDependencies ?? {};
  for (const packageName of app.frameworkConfig?.requiredRuntimePackages ?? []) {
    if (typeof dependencies[packageName] !== "string") {
      failures.push(`${app.id}: required TanStack runtime package is absent from dependencies: ${packageName}`);
    }
  }
  for (const packageName of app.frameworkConfig?.requiredBuildPackages ?? []) {
    if (typeof dependencies[packageName] !== "string" && typeof devDependencies[packageName] !== "string") {
      failures.push(`${app.id}: required TanStack build package is absent: ${packageName}`);
    }
  }
  for (const packageName of app.frameworkConfig?.forbiddenPackages ?? []) {
    if (typeof dependencies[packageName] === "string" || typeof devDependencies[packageName] === "string") {
      failures.push(`${app.id}: retired framework package remains declared: ${packageName}`);
    }
  }
  const configSource = fs.readFileSync(configPath, "utf8");
  for (const required of ["@tanstack/react-start/plugin/vite", "@vitejs/plugin-react"]) {
    if (!configSource.includes(required)) failures.push(`${app.id}: Vite config is missing required plugin import: ${required}`);
  }
  const outputEnv = app.build?.rawRootEnv;
  if (typeof outputEnv !== "string" || !outputEnv || !configSource.includes(outputEnv)) {
    failures.push(`${app.id}: Vite config must bind build output to build.rawRootEnv`);
  }
  if (!/manifest\s*:\s*true/u.test(configSource)) {
    failures.push(`${app.id}: Vite client build must emit manifest: true for Surface and bundle verification`);
  }
  return { configPath, requiredRuntimePackages: app.frameworkConfig?.requiredRuntimePackages ?? [] };
}

function inspectAdminTanstackServerFunctionSanitizer(app, workspaceRoot, appRoot, failures) {
  if (app.id !== "admin" || app.framework !== "tanstack-start") return;
  const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
  const patchEntries = Object.entries(rootPackage.patchedDependencies ?? {})
    .filter(([packageId]) => packageId.startsWith("@tanstack/start-server-core@"));
  if (patchEntries.length !== 1) {
    failures.push(`${app.id}: exactly one @tanstack/start-server-core patched dependency is required`);
    return;
  }

  const [packageId, patchSource] = patchEntries[0];
  try {
    resolveInside(workspaceRoot, patchSource, `${app.id}.${packageId}.patchSource`);
    const appRequire = createRequire(path.join(appRoot, "package.json"));
    const reactStartRequire = createRequire(appRequire.resolve("@tanstack/react-start/package.json"));
    const serverCoreRoot = path.dirname(reactStartRequire.resolve("@tanstack/start-server-core/package.json"));
    const serverCorePackage = readJson(path.join(serverCoreRoot, "package.json"));
    if (packageId !== `${serverCorePackage.name}@${serverCorePackage.version}`) {
      failures.push(`${app.id}: patched dependency ${packageId} does not match installed ${serverCorePackage.name}@${serverCorePackage.version}`);
    }
    const handlerSource = fs.readFileSync(path.join(serverCoreRoot, "dist/esm/server-functions-handler.js"), "utf8");
    const catchStart = handlerSource.indexOf("catch (error)");
    const catchEnd = handlerSource.indexOf("function isNotFoundResponse", catchStart);
    if (catchStart < 0 || catchEnd <= catchStart) {
      failures.push(`${app.id}: installed TanStack ServerFn error boundary cannot be located`);
      return;
    }
    const errorBoundary = handlerSource.slice(catchStart, catchEnd);
    if (errorBoundary.includes("console.error(error)")) {
      failures.push(`${app.id}: installed TanStack ServerFn boundary logs raw errors`);
    }
    if (errorBoundary.includes("toCrossJSONAsync(error")) {
      failures.push(`${app.id}: installed TanStack ServerFn boundary serializes raw errors`);
    }
    for (const required of [
      'event: "admin.server_function.failed"',
      'Response.json({ error: { code: "internal_server_error" } }',
    ]) {
      if (!errorBoundary.includes(required)) {
        failures.push(`${app.id}: installed TanStack ServerFn boundary is missing ${required}`);
      }
    }
    if (errorBoundary.includes("[X_TSS_SERIALIZED]")) {
      failures.push(`${app.id}: installed TanStack ServerFn fallback must not use Seroval error serialization`);
    }
  } catch (error) {
    failures.push(`${app.id}: cannot verify installed TanStack ServerFn sanitizer: ${error.message}`);
  }
}

function inspectPackages(app, workspaceRoot, appRoot, failures) {
  const appPackagePath = resolveInside(workspaceRoot, app.packageJson, `${app.id}.packageJson`);
  const appPackage = readJson(appPackagePath);
  const directWorkspace = new Set(
    Object.entries({ ...appPackage.dependencies, ...appPackage.optionalDependencies })
      .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
      .map(([name]) => name),
  );
  const contracts = new Map();
  for (const [index, contract] of (app.workspacePackages ?? []).entries()) {
    if (!contract || typeof contract.name !== "string") {
      failures.push(`${app.id}: workspacePackages[${index}].name is required`);
      continue;
    }
    if (contracts.has(contract.name)) {
      failures.push(`${app.id}: duplicate workspace package contract ${contract.name}`);
      continue;
    }
    if (!["server", "client", "hybrid"].includes(contract.classification)) {
      failures.push(`${app.id}: ${contract.name} classification must be server, client, or hybrid`);
    }
    const packageRoot = resolveInside(workspaceRoot, contract.root, `${app.id}.${contract.name}.root`);
    const packageJson = readJson(path.join(packageRoot, "package.json"));
    if (packageJson.name !== contract.name) failures.push(`${app.id}: ${contract.root} is ${packageJson.name}, expected ${contract.name}`);
    const lexical = findLexicalPackage(appRoot, workspaceRoot, contract.name);
    if (!lexical) failures.push(`${app.id}: ${contract.name} cannot be located through Bun workspace links`);
    else {
      const realpath = fs.realpathSync(lexical);
      if (realpath !== fs.realpathSync(packageRoot)) {
        failures.push(`${app.id}: ${contract.name} resolves to ${realpath}, not declared root ${packageRoot}`);
      }
      contract.resolution = { lexical, realpath };
    }
    if (!Array.isArray(contract.entrypoints) || contract.entrypoints.length === 0) {
      failures.push(`${app.id}: ${contract.name} requires at least one public entrypoint`);
      contract.entrypoints = [];
    }
    const declaredExports = new Set(contract.entrypoints.map((entrypoint) => entrypoint.export));
    const publicExports = typeof packageJson.exports === "string"
      ? ["."]
      : Object.keys(packageJson.exports ?? {}).filter((key) => key === "." || key.startsWith("./"));
    for (const exportName of publicExports) {
      if (exportName.includes("*")) continue;
      if (!declaredExports.has(exportName)) {
        failures.push(`${app.id}: ${contract.name} public export ${exportName} is not classified as an entrypoint`);
      }
    }
    const surfaces = new Set();
    for (const [entryIndex, entrypoint] of contract.entrypoints.entries()) {
      if (!["server", "client", "shared"].includes(entrypoint.surface)) {
        failures.push(`${app.id}: ${contract.name} entrypoint ${entryIndex} has invalid surface`);
        continue;
      }
      surfaces.add(entrypoint.surface);
      let source;
      try {
        source = resolveInside(packageRoot, entrypoint.path, `${app.id}.${contract.name}.entrypoints[${entryIndex}].path`);
      } catch (error) {
        failures.push(error.message);
        continue;
      }
      const scan = scanEntrypoint(source, packageRoot);
      entrypoint.scan = scan;
      if (entrypoint.surface === "server" && scan.signals.includes("client")) {
        failures.push(`${app.id}: server entrypoint ${exportSpecifier(contract.name, entrypoint.export)} reaches a client-only signal`);
      }
      if (entrypoint.surface === "client" && scan.signals.includes("server")) {
        failures.push(`${app.id}: client entrypoint ${exportSpecifier(contract.name, entrypoint.export)} reaches a server-only signal`);
      }
      if (entrypoint.export === "." && scan.signals.includes("server") && scan.signals.includes("client")) {
        failures.push(`${app.id}: root barrel ${contract.name} crosses server/client boundaries`);
      }
    }
    if (contract.classification === "server" && surfaces.has("client")) {
      failures.push(`${app.id}: server package ${contract.name} declares a client entrypoint`);
    }
    if (contract.classification === "client" && surfaces.has("server")) {
      failures.push(`${app.id}: client package ${contract.name} declares a server entrypoint`);
    }
    if (contract.classification === "hybrid" && !(surfaces.has("server") && surfaces.has("client"))) {
      failures.push(`${app.id}: hybrid package ${contract.name} must declare separate server and client entrypoints`);
    }
    contracts.set(contract.name, contract);
  }
  for (const name of directWorkspace) {
    if (!contracts.has(name)) failures.push(`${app.id}: direct workspace dependency ${name} is not classified`);
  }
  for (const name of contracts.keys()) {
    if (!directWorkspace.has(name)) failures.push(`${app.id}: ${name} is classified but is not a direct workspace dependency`);
  }
  return contracts;
}

export async function auditContract(manifestPath, appId, workspaceRootOverride = "") {
  const { manifest, workspaceRoot, app } = loadFrontendBuildContract(
    manifestPath,
    appId,
    workspaceRootOverride,
  );
  const appRoot = resolveInside(workspaceRoot, app.root, `${app.id}.root`);
  const blockers = sourcePrerequisiteBlockers(app, workspaceRoot);
  if (blockers.length > 0) {
    return {
      schema: "frontend-build-contract-audit.v1",
      app: app.id,
      framework: app.framework,
      status: "blocked",
      blockers,
      failures: blockers.map((blocker) => formatSourceBlocker(app.id, blocker)),
      runtimeBoundary: null,
      externalized: [],
      resolutions: [],
    };
  }
  const failures = [];
  const runtimeBoundary = inspectRuntimeApplicationBoundary(manifest, app, workspaceRoot, appRoot, failures);
  inspectPolicyFiles(app, workspaceRoot, failures);
  const packages = inspectPackages(app, workspaceRoot, appRoot, failures);
  const frameworkResult = app.framework === "nextjs"
    ? await inspectNextConfig(app, workspaceRoot, appRoot, packages, failures)
    : inspectTanstackConfig(app, workspaceRoot, appRoot, failures);
  inspectAdminTanstackServerFunctionSanitizer(app, workspaceRoot, appRoot, failures);
  return {
    schema: "frontend-build-contract-audit.v1",
    app: app.id,
    framework: app.framework,
    status: failures.length === 0 ? "passed" : "failed",
    blockers: [],
    failures,
    runtimeBoundary,
    externalized: frameworkResult.detected ?? [],
    resolutions: [...packages.values()].map((entry) => ({
      name: entry.name,
      classification: entry.classification,
      lexicalPath: entry.resolution?.lexical,
      realpath: entry.resolution?.realpath,
      entrypoints: entry.entrypoints.map((entrypoint) => ({
        export: entrypoint.export,
        surface: entrypoint.surface,
        signals: entrypoint.scan?.signals ?? [],
      })),
    })),
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await auditContract(options.manifest, options.app, options.workspaceRoot);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.status}: ${result.app}`);
      for (const resolution of result.resolutions) {
        console.log(`resolution ${resolution.name}: ${resolution.lexicalPath} -> ${resolution.realpath} (${resolution.classification})`);
      }
      for (const specifier of result.externalized) console.log(`external ${specifier}`);
      for (const failure of result.failures) console.error(`error: ${failure}`);
    }
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({
        schema: "frontend-build-contract-audit.v1",
        status: "failed",
        reason: "contract_error",
        error: error.message,
      }, null, 2));
    } else console.error(`error: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
