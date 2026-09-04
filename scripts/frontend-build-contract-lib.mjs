import fs from "node:fs";
import path from "node:path";

export const FRONTEND_BUILD_CONTRACT_SCHEMA = "frontend-build-contracts.v1";

export class FrontendBuildContractError extends Error {}

export function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findRepoRoot(start) {
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) {
      throw new FrontendBuildContractError("manifest is not inside a Git repository");
    }
  }
}

export function resolveInside(root, value, field, { mustExist = true } = {}) {
  if (typeof value !== "string" || !value) {
    throw new FrontendBuildContractError(`${field} must be a non-empty path`);
  }
  const resolved = path.resolve(root, value);
  if (!inside(resolved, root)) throw new FrontendBuildContractError(`${field} escapes the workspace root`);
  if (mustExist && !fs.existsSync(resolved)) {
    throw new FrontendBuildContractError(`${field} does not exist: ${resolved}`);
  }
  return resolved;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new FrontendBuildContractError(`cannot read JSON ${file}: ${error.message}`);
  }
}

export function loadFrontendBuildContract(manifestPath, appId, workspaceRootOverride = "") {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = readJson(absoluteManifest);
  if (manifest.schema !== FRONTEND_BUILD_CONTRACT_SCHEMA) {
    throw new FrontendBuildContractError(`manifest schema must be ${FRONTEND_BUILD_CONTRACT_SCHEMA}`);
  }
  const declaredWorkspaceRoot = path.resolve(path.dirname(absoluteManifest), manifest.workspaceRoot ?? ".");
  let workspaceRoot;
  if (workspaceRootOverride) {
    workspaceRoot = path.resolve(workspaceRootOverride);
    if (workspaceRoot !== declaredWorkspaceRoot) {
      throw new FrontendBuildContractError(
        `--workspace-root resolves to ${workspaceRoot}; manifest declares ${declaredWorkspaceRoot}`,
      );
    }
    if (!inside(absoluteManifest, workspaceRoot)) {
      throw new FrontendBuildContractError("manifest escapes the workspace root");
    }
  } else {
    const repoRoot = findRepoRoot(path.dirname(absoluteManifest));
    workspaceRoot = declaredWorkspaceRoot;
    if (!inside(workspaceRoot, repoRoot)) {
      throw new FrontendBuildContractError("workspaceRoot escapes the repository");
    }
  }
  if (!fs.statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new FrontendBuildContractError(`workspaceRoot does not exist: ${workspaceRoot}`);
  }
  const app = (manifest.apps ?? []).find((candidate) => candidate.id === appId);
  if (!app) throw new FrontendBuildContractError(`app not found in manifest: ${appId}`);
  if (!new Set(["nextjs", "tanstack-start"]).has(app.framework)) {
    throw new FrontendBuildContractError(`${appId}.framework must be nextjs or tanstack-start`);
  }
  return { absoluteManifest, manifest, workspaceRoot, app };
}

export function sourcePrerequisiteBlockers(app, workspaceRoot) {
  const blockers = [];
  for (const [index, value] of (app.sourcePrerequisites?.requiredPaths ?? []).entries()) {
    const resolved = resolveInside(
      workspaceRoot,
      value,
      `${app.id}.sourcePrerequisites.requiredPaths[${index}]`,
      { mustExist: false },
    );
    if (!fs.existsSync(resolved)) {
      blockers.push({ code: "required_source_missing", path: value });
    }
  }
  for (const [index, value] of (app.sourcePrerequisites?.forbiddenPaths ?? []).entries()) {
    const resolved = resolveInside(
      workspaceRoot,
      value,
      `${app.id}.sourcePrerequisites.forbiddenPaths[${index}]`,
      { mustExist: false },
    );
    if (fs.existsSync(resolved)) {
      blockers.push({ code: "retired_source_present", path: value });
    }
  }
  return blockers;
}

export function formatSourceBlocker(appId, blocker) {
  if (blocker.code === "required_source_missing") {
    return `${appId}: TanStack Start host source is not integrated; required path is missing: ${blocker.path}`;
  }
  if (blocker.code === "retired_source_present") {
    return `${appId}: TanStack Start host cutover is incomplete; retired Next source is still present: ${blocker.path}`;
  }
  return `${appId}: source prerequisite blocked: ${blocker.code} ${blocker.path ?? ""}`.trim();
}
