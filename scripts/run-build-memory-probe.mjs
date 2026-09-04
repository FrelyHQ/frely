#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "frontend-build-contracts.v1";
const MIB = 1024 * 1024;
const OUTPUT_LIMIT = 128 * 1024;

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("a build command is required after --");
  const command = argv.slice(separator + 1);
  const flags = argv.slice(0, separator);
  const options = { manifest: "", app: "", evidence: "", workspaceRoot: "", cgroupRoot: "/sys/fs/cgroup" };
  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index];
    if (arg === "--manifest") options.manifest = flags[++index] ?? "";
    else if (arg === "--app") options.app = flags[++index] ?? "";
    else if (arg === "--evidence") options.evidence = flags[++index] ?? "";
    else if (arg === "--workspace-root") options.workspaceRoot = flags[++index] ?? "";
    else if (arg === "--cgroup-root") options.cgroupRoot = flags[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.manifest || !options.app || !options.evidence) {
    throw new Error("--manifest, --app, and --evidence are required");
  }
  return { ...options, command };
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findRepoRoot(start) {
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) throw new Error("manifest is not inside a Git repository");
  }
}

function parseKeyValues(text) {
  return Object.fromEntries(text.trim().split(/\n+/).filter(Boolean).map((line) => {
    const [key, value] = line.trim().split(/\s+/, 2);
    return [key, Number(value)];
  }));
}

function readNumber(file) {
  const value = fs.readFileSync(file, "utf8").trim();
  if (!/^\d+$/.test(value)) throw new Error(`${file} is not a finite numeric cgroup value`);
  return Number(value);
}

function isColdPath(pathname) {
  const stat = fs.statSync(pathname, { throwIfNoEntry: false });
  if (!stat) return true;
  if (stat.isDirectory()) return fs.readdirSync(pathname).length === 0;
  return stat.size === 0;
}

function processTree(rootPid) {
  const queue = [rootPid];
  const result = new Set();
  while (queue.length > 0) {
    const pid = queue.pop();
    if (result.has(pid)) continue;
    result.add(pid);
    const childrenPath = `/proc/${pid}/task/${pid}/children`;
    const children = fs.readFileSync(childrenPath, "utf8", { flag: "r" }).trim().split(/\s+/).filter(Boolean);
    for (const child of children) queue.push(Number(child));
  }
  return result;
}

function rssBytes(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function appendBounded(existing, chunk) {
  const next = `${existing}${chunk}`;
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

export function classifyBuildExit({ code, signal, output, oomDelta, oomKillDelta }) {
  if (oomDelta > 0 || oomKillDelta > 0) return "cgroup_oom";
  if (/JavaScript heap out of memory|Reached heap limit|Ineffective mark-compacts near heap limit/i.test(output)) {
    return "v8_heap_oom";
  }
  if (code === 0 && !signal) return "success";
  if (signal === "SIGKILL") return "external_sigkill";
  if (code === 137) return "process_exit_137";
  if (signal) return "signal_exit";
  return "process_exit";
}

export function loadProbeContract(manifestPath, appId, workspaceRootOverride = "") {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absoluteManifest, "utf8"));
  if (manifest.schema !== SCHEMA) throw new Error(`manifest schema must be ${SCHEMA}`);
  const declaredWorkspaceRoot = path.resolve(path.dirname(absoluteManifest), manifest.workspaceRoot ?? ".");
  let workspaceRoot;
  if (workspaceRootOverride) {
    workspaceRoot = path.resolve(workspaceRootOverride);
    if (workspaceRoot !== declaredWorkspaceRoot) {
      throw new Error(`--workspace-root resolves to ${workspaceRoot}; manifest declares ${declaredWorkspaceRoot}`);
    }
  } else {
    const repoRoot = findRepoRoot(path.dirname(absoluteManifest));
    workspaceRoot = declaredWorkspaceRoot;
    if (!inside(workspaceRoot, repoRoot)) throw new Error("workspaceRoot escapes the repository");
  }
  if (!fs.statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`workspaceRoot does not exist: ${workspaceRoot}`);
  }
  const app = (manifest.apps ?? []).find((candidate) => candidate.id === appId);
  if (!app) throw new Error(`app not found in manifest: ${appId}`);
  if (!Number.isInteger(app.memory?.containerLimitMiB) || app.memory.containerLimitMiB <= 0) {
    throw new Error(`${appId}.memory.containerLimitMiB must be a positive integer`);
  }
  if (typeof app.memory.coldPath !== "string" || !app.memory.coldPath) {
    throw new Error(`${appId}.memory.coldPath is required`);
  }
  const coldPath = path.resolve(workspaceRoot, app.memory.coldPath);
  if (!inside(coldPath, workspaceRoot)) throw new Error("memory.coldPath escapes the workspace root");
  return { app, workspaceRoot, coldPath };
}

export async function runProbe({ app, workspaceRoot, coldPath, command, evidencePath, cgroupRoot }) {
  const memoryMaxPath = path.join(cgroupRoot, "memory.max");
  const memoryCurrentPath = path.join(cgroupRoot, "memory.current");
  const memoryEventsPath = path.join(cgroupRoot, "memory.events");
  if (!fs.existsSync(path.join(cgroupRoot, "cgroup.controllers"))) {
    throw new Error(`${cgroupRoot} is not a cgroup v2 root`);
  }
  const actualLimit = readNumber(memoryMaxPath);
  const expectedLimit = app.memory.containerLimitMiB * MIB;
  if (actualLimit !== expectedLimit) {
    throw new Error(`memory.max is ${actualLimit} bytes; expected exact ${expectedLimit} byte (${app.memory.containerLimitMiB} MiB) gate`);
  }
  if (!isColdPath(coldPath)) throw new Error(`cold build path is not absent or empty: ${coldPath}`);
  const before = parseKeyValues(fs.readFileSync(memoryEventsPath, "utf8"));
  let tail = "";
  let peakRssBytes = 0;
  let peakCgroupBytes = readNumber(memoryCurrentPath);
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const writeSpawnFailure = (error) => {
    const result = {
      schema: "frontend-build-memory-evidence.v1",
      app: app.id,
      status: "failed",
      reason: "spawn_error",
      message: error.message,
      command,
      containerLimitMiB: app.memory.containerLimitMiB,
      heapLimitMiB: app.memory.heapLimitMiB ?? null,
      coldPath,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
  let child;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
  } catch (error) {
    return writeSpawnFailure(error);
  }
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      process[stream === child.stdout ? "stdout" : "stderr"].write(chunk);
      tail = appendBounded(tail, chunk.toString("utf8"));
    });
  }
  const sampler = setInterval(() => {
    try {
      let rss = 0;
      for (const pid of processTree(child.pid)) rss += rssBytes(pid);
      peakRssBytes = Math.max(peakRssBytes, rss);
      peakCgroupBytes = Math.max(peakCgroupBytes, readNumber(memoryCurrentPath));
    } catch {
      // Process exit can race a /proc sample. Final cgroup/exit evidence remains authoritative.
    }
  }, 100);
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearInterval(sampler);
  if (outcome.error) return writeSpawnFailure(outcome.error);
  const { code, signal } = outcome;
  const after = parseKeyValues(fs.readFileSync(memoryEventsPath, "utf8"));
  const oomDelta = (after.oom ?? 0) - (before.oom ?? 0);
  const oomKillDelta = (after.oom_kill ?? 0) - (before.oom_kill ?? 0);
  const reason = classifyBuildExit({ code, signal, output: tail, oomDelta, oomKillDelta });
  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  const result = {
    schema: "frontend-build-memory-evidence.v1",
    app: app.id,
    status: reason === "success" ? "passed" : "failed",
    reason,
    command,
    containerLimitMiB: app.memory.containerLimitMiB,
    heapLimitMiB: app.memory.heapLimitMiB ?? null,
    coldPath,
    coldPathWasEmpty: true,
    peakRssMiB: Number((peakRssBytes / MIB).toFixed(3)),
    peakCgroupMiB: Number((peakCgroupBytes / MIB).toFixed(3)),
    exitCode: code,
    signal,
    cgroupEventsDelta: { oom: oomDelta, oomKill: oomKillDelta },
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Number(elapsedMs.toFixed(3)),
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const contract = loadProbeContract(options.manifest, options.app, options.workspaceRoot);
    const evidencePath = path.resolve(options.evidence);
    const result = await runProbe({
      ...contract,
      command: options.command,
      evidencePath,
      cgroupRoot: path.resolve(options.cgroupRoot),
    });
    console.log(`build-memory ${result.status}: ${result.reason}; evidence=${evidencePath}`);
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
