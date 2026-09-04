import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFrontendBuildContract } from "./frontend-build-contract-lib.mjs";

const appId = process.argv[2];
const manifestFlag = process.argv.indexOf("--manifest");
const manifestPath = manifestFlag >= 0 ? process.argv[manifestFlag + 1] : "ops/build/frontend-build-contracts.json";
if (!appId) {
  console.error("Usage: verify-shared-ui-bundle-budget.mjs <app> [--manifest <path>]");
  process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const { app } = loadFrontendBuildContract(resolve(root, manifestPath), appId, root);
const budgets = await readJson(resolve(root, "scripts/shared-ui-bundle-budgets.json"));
if (!budgets[appId] || typeof budgets[appId] !== "object") throw new Error(`${appId}: no shared UI bundle budgets declared`);
const buildManifestPath = resolve(root, app.bundle.manifest);
const buildManifest = await readJson(buildManifestPath);
const assetsRoot = resolve(root, app.bundle.assetsRoot);
const failures = [];

if (app.bundle.kind === "next-app-build-manifest") {
  for (const [route, maximumBytes] of Object.entries(budgets[appId])) {
    const files = buildManifest.pages?.[route];
    if (!Array.isArray(files) || files.length === 0) {
      failures.push(`${route}: route is absent from app-build-manifest.json`);
      continue;
    }
    report(route, await totalBytes(files.map((file) => resolve(assetsRoot, file))), maximumBytes);
  }
} else if (app.bundle.kind === "vite-manifest") {
  const routeFiles = await tanstackRouteFiles(resolve(root, app.surface.sourceRoot));
  for (const [route, maximumBytes] of Object.entries(budgets[appId])) {
    const source = routeFiles.get(route);
    if (!source) {
      failures.push(`${route}: no TanStack route source maps to the budgeted Surface`);
      continue;
    }
    const sourceRelative = relative(root, source).split(sep).join("/");
    const appRelative = relative(resolve(root, app.root), source).split(sep).join("/");
    const key = Object.keys(buildManifest).find((candidate) => {
      const normalized = candidate.split("?")[0].split(sep).join("/");
      return normalized === sourceRelative || normalized.endsWith(`/${sourceRelative}`)
        || normalized === appRelative || normalized.endsWith(`/${appRelative}`);
    });
    if (!key) {
      failures.push(`${route}: route source is absent from Vite manifest (${sourceRelative})`);
      continue;
    }
    const assetFiles = collectViteAssets(buildManifest, key).map((file) => resolve(assetsRoot, file));
    report(route, await totalBytes(assetFiles), maximumBytes);
  }
} else throw new Error(`${appId}: unsupported bundle manifest kind ${app.bundle.kind}`);

if (failures.length > 0) {
  console.error(`Shared UI bundle budget failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

function report(route, bytes, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error(`${appId} ${route}: budget must be a positive integer`);
  if (bytes > maximumBytes) failures.push(`${route}: ${bytes} bytes exceeds ${maximumBytes}`);
  else console.log(`${appId} ${route}: ${bytes}/${maximumBytes} bytes`);
}

function collectViteAssets(manifest, entryKey) {
  const visited = new Set();
  const files = new Set();
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.pop();
    if (!key || visited.has(key)) continue;
    visited.add(key);
    const entry = manifest[key];
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.file === "string") files.add(entry.file);
    for (const collection of [entry.css, entry.assets]) {
      if (Array.isArray(collection)) for (const file of collection) if (typeof file === "string") files.add(file);
    }
    for (const dependency of entry.imports ?? []) queue.push(dependency);
  }
  return [...files];
}

async function totalBytes(files) {
  const unique = [...new Set(files)];
  return (await Promise.all(unique.map((file) => stat(file)))).reduce((total, entry) => total + entry.size, 0);
}

async function tanstackRouteFiles(routesRoot) {
  const result = new Map();
  for (const file of await walk(routesRoot)) {
    if (!/\.(?:lazy\.)?[cm]?[jt]sx?$/u.test(file) || /\.(?:test|spec)\.[^.]+$/u.test(file)) continue;
    const route = routeFromFile(routesRoot, file);
    if (!route) continue;
    const existing = result.get(route);
    if (!existing || isIndexRouteFile(file)) {
      result.set(route, file);
      continue;
    }
    if (!isIndexRouteFile(existing)) throw new Error(`${appId}: duplicate TanStack route source for ${route}`);
  }
  return result;
}

function isIndexRouteFile(file) {
  const basename = file.split(sep).at(-1) ?? "";
  return /(?:^|\.)index\.(?:lazy\.)?[cm]?[jt]sx?$/u.test(basename);
}

function routeFromFile(routesRoot, file) {
  let value = relative(routesRoot, file).split(sep).join("/").replace(/\.(?:lazy\.)?[cm]?[jt]sx?$/u, "");
  if (value === "__root" || value.startsWith("-")) return null;
  const segments = [];
  for (const segment of splitTanstackFlatRoute(value)) {
    if (["index", "route", "__root"].includes(segment)) continue;
    if ((segment.startsWith("(") && segment.endsWith(")")) || segment.startsWith("_")) continue;
    if (segment.startsWith("-")) return null;
    segments.push(segment === "$" ? "[...splat]" : segment.startsWith("$") ? `[${segment.slice(1)}]` : segment.replace(/\[(.*?)\]/gu, "$1"));
  }
  return `/${segments.join("/")}` || "/";
}

function splitTanstackFlatRoute(value) {
  const segments = [];
  let segment = "";
  let bracketDepth = 0;
  for (const character of value) {
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (bracketDepth === 0 && (character === "/" || character === ".")) {
      if (segment) segments.push(segment);
      segment = "";
      continue;
    }
    segment += character;
  }
  if (segment) segments.push(segment);
  return segments;
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
