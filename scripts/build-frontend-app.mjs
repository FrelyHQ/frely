#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSourceBlocker,
  inside,
  loadFrontendBuildContract,
  sourcePrerequisiteBlockers,
} from "./frontend-build-contract-lib.mjs";

const options = parseArgs(process.argv.slice(2));
const { absoluteManifest, app, workspaceRoot } = loadFrontendBuildContract(options.manifest, options.app, options.workspaceRoot);
const blockers = sourcePrerequisiteBlockers(app, workspaceRoot);
if (blockers.length > 0) {
  for (const blocker of blockers) console.error(`frontend-build-blocked: ${formatSourceBlocker(app.id, blocker)}`);
  process.exit(3);
}
if (app.framework !== "tanstack-start") {
  throw new Error(`${app.id}: build-frontend-app currently owns only the TanStack Start artifact lane`);
}
const rawRoot = resolveOutput(app.build?.rawRoot, "build.rawRoot");
const artifactRoot = resolveOutput(app.build?.artifactRoot, "build.artifactRoot");
if (rawRoot === artifactRoot || inside(rawRoot, artifactRoot) || inside(artifactRoot, rawRoot)) {
  throw new Error(`${app.id}: raw and filtered artifact roots must not overlap`);
}
for (const output of [rawRoot, artifactRoot]) fs.rmSync(output, { recursive: true, force: true });

run(["bun", "scripts/generate-ui-surface-registries.mjs", "verify"], process.env);
const command = app.build?.command;
if (!Array.isArray(command) || command.length === 0 || command.some((value) => typeof value !== "string" || !value)) {
  throw new Error(`${app.id}.build.command must be a non-empty command array`);
}
const outputEnv = app.build?.rawRootEnv;
if (typeof outputEnv !== "string" || !outputEnv) throw new Error(`${app.id}.build.rawRootEnv is required`);
run(command, { ...process.env, [outputEnv]: rawRoot });
run([
  "bun",
  "scripts/build-tanstack-start-artifact.mjs",
  "--manifest", absoluteManifest,
  "--app", app.id,
  "--workspace-root", workspaceRoot,
], process.env);
run(["bun", "scripts/generate-ui-surface-registries.mjs", "verify-manifest", app.id], process.env);
run(["bun", "scripts/verify-shared-ui-bundle-budget.mjs", app.id, "--manifest", absoluteManifest], process.env);
run([
  "bun",
  "scripts/audit-frontend-artifact-closure.mjs",
  "--manifest", absoluteManifest,
  "--app", app.id,
  "--workspace-root", workspaceRoot,
], process.env);
console.log(`frontend-build passed: ${app.id} (${app.framework})`);

function run(command, env) {
  const result = spawnSync(command[0], command.slice(1), { cwd: workspaceRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${app.id}: command failed (${result.status}): ${command.join(" ")}`);
}

function resolveOutput(value, field) {
  if (typeof value !== "string" || !value) throw new Error(`${app.id}.${field} is required`);
  const resolved = path.resolve(workspaceRoot, value);
  if (!inside(resolved, workspaceRoot)) throw new Error(`${app.id}.${field} escapes workspace root`);
  return resolved;
}

function parseArgs(argv) {
  const result = { manifest: "ops/build/frontend-build-contracts.json", app: "admin", workspaceRoot: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") result.manifest = argv[++index] ?? "";
    else if (arg === "--app") result.app = argv[++index] ?? "";
    else if (arg === "--workspace-root") result.workspaceRoot = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error("build-frontend-app must be executed directly");
}
