import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function stagePatchedDependencySources({ sourceRoot, destinationRoot, patchedDependencies }) {
  if (patchedDependencies === undefined) return [];
  if (patchedDependencies === null || typeof patchedDependencies !== "object" || Array.isArray(patchedDependencies)) {
    throw new Error("patchedDependencies must be an object");
  }

  const canonicalSourceRoot = await realpath(sourceRoot);
  const staged = [];
  const copiedSources = new Set();
  for (const [packageId, patchSource] of Object.entries(patchedDependencies).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof patchSource !== "string" || !patchSource.trim()) {
      throw new Error(`patched dependency ${packageId} must declare a non-empty source path`);
    }
    if (isAbsolute(patchSource)) {
      throw new Error(`patched dependency ${packageId} source must be relative to the workspace root`);
    }

    const source = resolveInside(sourceRoot, patchSource, `patched dependency ${packageId} source`);
    const canonicalSource = await realpath(source);
    if (!inside(canonicalSourceRoot, canonicalSource)) {
      throw new Error(`patched dependency ${packageId} source escapes the workspace root through a symlink`);
    }
    const metadata = await lstat(source);
    if (!metadata.isFile()) {
      throw new Error(`patched dependency ${packageId} source must be a regular file`);
    }

    const relativeSource = relative(sourceRoot, source);
    if (copiedSources.has(relativeSource)) continue;
    const destination = resolveInside(destinationRoot, relativeSource, `patched dependency ${packageId} destination`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copiedSources.add(relativeSource);
    staged.push(relativeSource);
  }
  return staged;
}

function resolveInside(root, value, label) {
  const resolved = resolve(root, value);
  if (!inside(root, resolved)) throw new Error(`${label} escapes its root`);
  return resolved;
}

function inside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}
