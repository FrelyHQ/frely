#!/usr/bin/env bun
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaces = await loadWorkspaces(root);
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
const selected = new Set();
visit("@frely/db-ops");

for (const name of [...selected].sort()) {
  const workspace = byName.get(name);
  if (!workspace) throw new Error(`identity_tenancy_verification_workspace_missing:${name}`);
  await rm(join(workspace.directory, "dist"), { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ cleanedWorkspaceDistCount: selected.size })}\n`);

function visit(name) {
  if (selected.has(name)) return;
  const workspace = byName.get(name);
  if (!workspace) throw new Error(`identity_tenancy_verification_workspace_missing:${name}`);
  selected.add(name);
  for (const [dependency, version] of Object.entries({
    ...workspace.manifest.dependencies,
    ...workspace.manifest.optionalDependencies,
    ...workspace.manifest.peerDependencies,
    ...workspace.manifest.devDependencies,
  })) {
    if (typeof version === "string" && version.startsWith("workspace:")) visit(dependency);
  }
}

async function loadWorkspaces(workspaceRoot) {
  const result = [];
  for (const parent of ["apps", "packages"]) {
    const parentPath = join(workspaceRoot, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parentPath, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (typeof manifest.name === "string") result.push({ name: manifest.name, directory, manifest });
    }
  }
  return result;
}
