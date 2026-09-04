#!/usr/bin/env bun
import { access, chmod, cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { stagePatchedDependencySources } from "./stage-patched-dependency-sources.mjs";

const root = resolve(import.meta.dir, "..");
const options = parseArgs(process.argv.slice(2));
const workspaces = await discoverWorkspaces();
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
const target = byName.get(options.packageName);
if (!target) throw new Error(`unknown workspace package: ${options.packageName}`);
const closure = workspaceClosure(target, byName);
const temporary = `${options.output}.tmp.${process.pid}`;

await rm(temporary, { recursive: true, force: true });
await mkdir(temporary, { recursive: true });
try {
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(temporary, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
  await cp(join(root, "bun.lock"), join(temporary, "bun.lock"));
  await cp(join(root, "bunfig.toml"), join(temporary, "bunfig.toml"));
  await stagePatchedDependencySources({
    sourceRoot: root,
    destinationRoot: temporary,
    patchedDependencies: rootManifest.patchedDependencies,
  });
  for (const workspace of workspaces) {
    const relative = workspace.relativeDirectory;
    const destination = join(temporary, relative);
    await mkdir(destination, { recursive: true });
    await cp(join(workspace.directory, "package.json"), join(destination, "package.json"));
    await chmod(join(destination, "package.json"), 0o644);
    if (!closure.has(workspace.name)) continue;
    for (const artifact of ["dist", "prisma", "prisma.config.ts"]) {
      const source = join(workspace.directory, artifact);
      try { await cp(source, join(destination, artifact), { recursive: true }); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  await run("bun", ["install", "--production", "--frozen-lockfile", "--offline", "--filter", options.packageName], temporary);
  if (options.includePrismaCli) {
    const prismaVersion = target.manifest.devDependencies?.prisma;
    if (typeof prismaVersion !== "string") throw new Error(`${options.packageName} does not declare a Prisma CLI version`);
    await run("bun", ["install", "--offline", "--no-save", "--omit=dev", `prisma@${prismaVersion}`], temporary);
  }
  await ensureBunRootLinks(temporary);
  await rm(options.output, { recursive: true, force: true });
  await rename(temporary, options.output);
  process.stdout.write(JSON.stringify({
    schema: "friday-relay.bun-service-artifact.v1",
    package: options.packageName,
    output: options.output,
    workspaceClosure: [...closure].sort(),
    productionInstall: true,
  }) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function discoverWorkspaces() {
  const result = [];
  for (const directory of ["apps", "packages"]) {
    const entries = await Array.fromAsync(new Bun.Glob("*/package.json").scan({ cwd: join(root, directory), onlyFiles: true }));
    for (const relativePath of entries.sort()) {
      const relativeDirectory = join(directory, relativePath, "..");
      const directoryPath = resolve(root, relativeDirectory);
      const manifest = JSON.parse(await readFile(join(root, directory, relativePath), "utf8"));
      result.push({ name: manifest.name, directory: directoryPath, relativeDirectory, manifest });
    }
  }
  return result;
}

function workspaceClosure(target, byName) {
  const result = new Set();
  const visit = (workspace) => {
    if (result.has(workspace.name)) return;
    result.add(workspace.name);
    for (const dependency of workspaceDependencies(workspace.manifest)) {
      const dependencyWorkspace = byName.get(dependency);
      if (!dependencyWorkspace) throw new Error(`${workspace.name} references missing workspace ${dependency}`);
      visit(dependencyWorkspace);
    }
  };
  visit(target);
  return result;
}

function workspaceDependencies(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }).filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
    .map(([name]) => name);
}

async function ensureBunRootLinks(artifactRoot) {
  const storeModules = join(artifactRoot, "node_modules", ".bun", "node_modules");
  for (const packageName of ["canonicalize", "fast-json-patch", "jsonwebtoken", "llm-bridge", "undici", "zod"]) {
    await linkPackage(artifactRoot, packageName, join(storeModules, packageName));
  }
  await linkPackage(artifactRoot, "@dsnp/parquetjs", join(storeModules, "@dsnp", "parquetjs"));
}

async function linkPackage(artifactRoot, packageName, target) {
  const link = join(artifactRoot, "node_modules", packageName);
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await mkdir(dirname(link), { recursive: true });
  await rm(link, { recursive: true, force: true });
  await symlink(relative(dirname(link), target), link, "junction");
}

function parseArgs(args) {
  let packageName = "";
  let output = "";
  let includePrismaCli = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--package") packageName = args[++index] ?? "";
    else if (arg === "--output") output = resolve(root, args[++index] ?? "");
    else if (arg === "--include-prisma-cli") includePrismaCli = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!packageName.startsWith("@frely/")) throw new Error("--package must be a Frely workspace package");
  if (!output || output === root || output === "/") throw new Error("--output must be a separate artifact directory");
  return { packageName, output, includePrismaCli };
}

async function run(executable, args, cwd) {
  await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) reject(new Error(`command failed: ${[executable, ...args].join(" ")}`));
      else resolveResult();
    });
  });
}
