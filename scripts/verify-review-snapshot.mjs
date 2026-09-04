#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const forbiddenPaths = [".agents", ".codex", ".pi", ".pi-glla", "AGENTS.md", "data", "outputs", "tmp", "skills", "docs/archive", "docs/defects", "docs/plans", "docker-compose.e2e.yml", "ops/deployment", "ops/local-e2e", "ops/release", "ops/topology", "ops/owner-credentials"];
for (const path of forbiddenPaths) if (existsSync(join(root, path))) fail(`Forbidden path exists: ${path}`);
for (const file of await walk(root)) {
  if (file.endsWith("verify-review-snapshot.mjs") || /\.(?:tar\.gz|png|jpe?g)$/u.test(file)) continue;
  const buffer = await readFile(file);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu.test(text)) fail(`Private key marker found: ${relative(root, file)}`);
  if (/(?:wyattcoder\.top|\bctb-(?:eu|sg)\b|100\.124\.54\.(?:53|54)|\bdmit-la\b)/iu.test(text)) fail(`Private infrastructure identity found: ${relative(root, file)}`);
  if (/(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{16,}|whsec_(?!test\b)[A-Za-z0-9]{16,}|\bre_[A-Za-z0-9]{20,}\b)/u.test(text)) fail(`Credential-shaped value found: ${relative(root, file)}`);
}
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (rootPackage.private !== true || rootPackage.license !== "Apache-2.0") fail("Root package metadata is not publication-safe");
console.log("Review snapshot checks passed");

async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if ([".git", "node_modules", ".next", ".next-dev", ".output", "dist", "coverage"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await walk(child));
    else result.push(child);
  }
  return result;
}
function fail(message) { console.error(message); process.exit(1); }
