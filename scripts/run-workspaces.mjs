#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { cleanWorkspaceOutputs } from "./workspace-output-cleanup.mjs";

const root = resolve(import.meta.dir, "..");
const options = parseArgs(process.argv.slice(2));
const workspaces = await discoverWorkspaces();
const selectedNames = selectWorkspaceNames(workspaces, options.includes, options.excludes);
const selected = workspaces.filter((workspace) => selectedNames.has(workspace.name));
const levels = topologicalLevels(selected, selectedNames);

if (options.plan) {
  process.stdout.write(`${JSON.stringify({
    schema: "friday-relay.bun-workspace-plan.v1",
    script: options.script,
    concurrency: options.concurrency,
    cleanOutput: options.cleanOutput,
    levels: levels.map((level) => level.map((workspace) => workspace.name)),
  }, null, 2)}\n`);
  process.exit(0);
}

await cleanWorkspaceOutputs(selected, options.cleanOutput);

for (const level of levels) {
  for (let offset = 0; offset < level.length; offset += options.concurrency) {
    const batch = level.slice(offset, offset + options.concurrency);
    const results = await Promise.all(batch.map((workspace) => runWorkspace(workspace, options.script, options.args)));
    const failed = results.find((result) => result !== 0);
    if (failed !== undefined) process.exit(failed);
  }
}

async function discoverWorkspaces() {
  const roots = ["apps", "packages"];
  const result = [];
  for (const directory of roots) {
    const entries = await Array.fromAsync(new Bun.Glob("*/package.json").scan({ cwd: join(root, directory), onlyFiles: true }));
    for (const relativePath of entries.sort()) {
      const directoryPath = join(root, directory, relativePath, "..");
      const packagePath = join(root, directory, relativePath);
      const manifest = JSON.parse(await readFile(packagePath, "utf8"));
      if (typeof manifest.name !== "string" || manifest.private === false) throw new Error(`workspace package name is required: ${packagePath}`);
      result.push({ name: manifest.name, directory: resolve(directoryPath), manifest });
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function selectWorkspaceNames(workspaces, includes, excludes) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const selected = new Set(includes.size ? [...includes] : workspaces.map((workspace) => workspace.name));
  const visit = (name) => {
    const workspace = byName.get(name);
    if (!workspace) throw new Error(`unknown workspace package: ${name}`);
    for (const dependency of workspaceDependencies(workspace.manifest)) {
      if (!selected.has(dependency)) selected.add(dependency);
      visit(dependency);
    }
  };
  for (const name of [...selected]) visit(name);
  for (const name of excludes) selected.delete(name);
  return selected;
}

function topologicalLevels(workspaces, selectedNames) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const dependencies = new Map(workspaces.map((workspace) => [workspace.name, workspaceDependencies(workspace.manifest).filter((name) => selectedNames.has(name))]));
  const remaining = new Set(workspaces.map((workspace) => workspace.name));
  const levels = [];
  while (remaining.size > 0) {
    const level = [...remaining].filter((name) => (dependencies.get(name) ?? []).every((dependency) => !remaining.has(dependency))).sort();
    if (level.length === 0) throw new Error(`workspace dependency cycle detected: ${[...remaining].sort().join(", ")}`);
    levels.push(level.map((name) => byName.get(name)));
    for (const name of level) remaining.delete(name);
  }
  return levels;
}

function workspaceDependencies(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }).filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
    .map(([name]) => name);
}

async function runWorkspace(workspace, script, args) {
  process.stdout.write(`\n[bun workspace] ${workspace.name} ${script}\n`);
  return await new Promise((resolveResult) => {
    const child = spawn("bun", ["run", "--bun", "--cwd", workspace.directory, script, ...args], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", () => resolveResult(1));
    child.once("exit", (code, signal) => resolveResult(signal ? 1 : code ?? 1));
  });
}

function parseArgs(args) {
  let script = "";
  let concurrencyValue = "auto";
  let plan = false;
  const includes = new Set();
  const excludes = new Set();
  let cleanOutput = null;
  const forwarded = [];
  let separator = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (separator) {
      forwarded.push(arg);
    } else if (arg === "--") {
      separator = true;
    } else if (arg === "--script") {
      script = args[++index] ?? "";
    } else if (arg === "--concurrency") {
      concurrencyValue = args[++index] ?? "";
    } else if (arg === "--include") {
      includes.add(args[++index] ?? "");
    } else if (arg === "--exclude") {
      excludes.add(args[++index] ?? "");
    } else if (arg === "--clean-output") {
      cleanOutput = args[++index] ?? "";
    } else if (arg === "--plan") {
      plan = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!/^[A-Za-z0-9:_-]+$/u.test(script)) throw new Error("--script must be a package script name");
  if (concurrencyValue !== "auto" && !/^[1-9][0-9]*$/u.test(concurrencyValue)) throw new Error("--concurrency must be auto or a positive integer");
  const concurrency = concurrencyValue === "auto" ? Math.max(1, availableParallelism()) : Number(concurrencyValue);
  if (cleanOutput !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(cleanOutput)) throw new Error("--clean-output must be one direct workspace output directory name");
  return { script, concurrency, includes, excludes, cleanOutput, plan, args: forwarded };
}
