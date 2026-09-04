#!/usr/bin/env bun
import { access, mkdir, readlink, readFile, readdir, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const nodeModules = resolve(root, "node_modules");
const storeModules = resolve(nodeModules, ".bun", "node_modules");
const packages = ["canonicalize", "fast-json-patch", "jsonwebtoken", "llm-bridge", "thrift", "undici", "zod"];
const namespacePackages = [["@dsnp", "parquetjs"]];

for (const packageName of packages) await linkPackage(packageName, resolve(storeModules, packageName));
for (const [namespace, packageName] of namespacePackages) await linkPackage(`${namespace}/${packageName}`, resolve(storeModules, namespace, packageName));
for (const workspaceDirectory of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, workspaceDirectory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, workspaceDirectory, entry.name);
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")); } catch { continue; }
    if (typeof manifest.name === "string" && manifest.name.startsWith("@frely/")) {
      await linkPackage(manifest.name, directory);
    }
  }
}

async function linkPackage(packageName, target) {
  const link = resolve(nodeModules, packageName);
  await mkdir(dirname(link), { recursive: true });
  try {
    if (target.startsWith(storeModules)) await readlink(target);
    else await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await rm(link, { force: true, recursive: true });
  await symlink(relative(dirname(link), target), link, "junction");
}
