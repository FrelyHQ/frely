import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PostgresPrismaRuntimeArtifacts {
  packageRoot: string;
  prismaCliEntry: string;
  prismaConfig: string;
  schema: string;
  migrationsRoot: string;
}

type PostgresPrismaRuntimeArtifactResolutionOptions = {
  moduleUrl?: string | URL;
  cwd?: string;
};

export function resolvePostgresPrismaRuntimeArtifacts(
  options: PostgresPrismaRuntimeArtifactResolutionOptions = {},
): PostgresPrismaRuntimeArtifacts {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const packageRoot = resolvePostgresPackageRoot(moduleUrl, options.cwd ?? process.cwd());
  const packageRequire = createRequire(moduleUrl);
  return {
    packageRoot,
    get prismaCliEntry() {
      return packageRequire.resolve("prisma/build/index.js");
    },
    prismaConfig: resolve(packageRoot, "prisma.config.ts"),
    schema: resolve(packageRoot, "prisma/schema.prisma"),
    migrationsRoot: resolve(packageRoot, "prisma/migrations"),
  };
}

function resolvePostgresPackageRoot(moduleUrl: string | URL, cwd: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const modulePackageRoot = resolve(moduleDirectory, "..");
  if (hasPrismaMigrations(modulePackageRoot)) return modulePackageRoot;

  // A filtered frontend artifact carries an ownership marker at its root. Its
  // runtime include is fixed at server/prisma, so never fall through to a
  // surrounding checkout that could hide a missing production artifact.
  const artifactRoot = ancestorDirectories(moduleDirectory)
    .find((directory) => isFile(resolve(directory, "artifact-manifest.json")));
  if (artifactRoot) {
    const artifactServerRoot = resolve(artifactRoot, "server");
    if (hasPrismaMigrations(artifactServerRoot)) return artifactServerRoot;
    throw new Error("postgres_prisma_runtime_artifacts_not_found");
  }

  const candidates = [
    ...ancestorDirectories(moduleDirectory),
    ...ancestorDirectories(cwd),
  ].map((directory) => resolve(directory, "packages/postgres"));
  for (const candidate of new Set(candidates)) {
    if (hasPrismaMigrations(candidate)) return candidate;
  }
  throw new Error("postgres_prisma_runtime_artifacts_not_found");
}

function ancestorDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = resolve(start);
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

function hasPrismaMigrations(packageRoot: string): boolean {
  return isDirectory(resolve(packageRoot, "prisma/migrations"));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
