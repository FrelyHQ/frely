import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";

export function validateWorkspaceOutputName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value === "." || value === "..") {
    throw new Error("--clean-output must be one direct workspace output directory name");
  }
  return value;
}

export function resolveWorkspaceOutputPath(workspaceDirectory, outputName) {
  const workspaceRoot = resolve(workspaceDirectory);
  const validatedOutputName = validateWorkspaceOutputName(outputName);
  const outputPath = resolve(workspaceRoot, validatedOutputName);
  if (outputPath === workspaceRoot) throw new Error("workspace output must not resolve to the workspace root");
  return outputPath;
}

export async function cleanWorkspaceOutputs(workspaces, outputName) {
  if (outputName === null) return;
  for (const workspace of workspaces) {
    const outputPath = resolveWorkspaceOutputPath(workspace.directory, outputName);
    let state;
    try {
      state = await lstat(outputPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (state.isSymbolicLink()) throw new Error(`workspace output must not be a symlink: ${workspace.name}/${outputName}`);
    await rm(outputPath, { recursive: true, force: false });
  }
}
