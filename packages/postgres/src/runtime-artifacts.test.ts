import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { committedPrismaMigrationNames } from "./migration-state.js";
import { resolvePostgresPrismaRuntimeArtifacts } from "./runtime-artifacts.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PostgreSQL Prisma runtime artifacts", () => {
  test("resolves a filtered frontend runtime independently of package-script cwd", () => {
    const fixtureRoot = temporaryDirectory();
    const runtimeRoot = resolve(fixtureRoot, "apps/admin/.output/runtime");
    const packageRoot = resolve(runtimeRoot, "server");
    const migrationName = "20260830000000_runtime_fixture";
    mkdirSync(resolve(packageRoot, "prisma/migrations", migrationName), { recursive: true });
    writeFileSync(resolve(runtimeRoot, "artifact-manifest.json"), "{}\n");

    const artifacts = resolvePostgresPrismaRuntimeArtifacts({
      moduleUrl: pathToFileURL(resolve(runtimeRoot, "server/assets/server.js")),
      cwd: resolve(fixtureRoot, "apps/admin"),
    });

    expect(artifacts.packageRoot).toBe(packageRoot);
    expect(artifacts.schema).toBe(resolve(packageRoot, "prisma/schema.prisma"));
    expect(artifacts.migrationsRoot).toBe(resolve(packageRoot, "prisma/migrations"));
    expect(committedPrismaMigrationNames(artifacts.migrationsRoot)).toEqual([migrationName]);
  });

  test("does not hide a missing filtered runtime include with checkout files", () => {
    const fixtureRoot = temporaryDirectory();
    const runtimeRoot = resolve(fixtureRoot, "apps/admin/.output/runtime");
    mkdirSync(resolve(runtimeRoot, "server/assets"), { recursive: true });
    mkdirSync(resolve(fixtureRoot, "packages/postgres/prisma/migrations"), { recursive: true });
    writeFileSync(resolve(runtimeRoot, "artifact-manifest.json"), "{}\n");

    expect(() => resolvePostgresPrismaRuntimeArtifacts({
      moduleUrl: pathToFileURL(resolve(runtimeRoot, "server/assets/server.js")),
      cwd: resolve(fixtureRoot, "apps/admin"),
    })).toThrow("postgres_prisma_runtime_artifacts_not_found");
  });

  test("keeps a package-local Prisma directory authoritative", () => {
    const fixtureRoot = temporaryDirectory();
    const installedPackageRoot = resolve(fixtureRoot, "node_modules/@frely/postgres");
    const unrelatedWorkspaceRoot = resolve(fixtureRoot, "workspace");
    mkdirSync(resolve(installedPackageRoot, "prisma/migrations"), { recursive: true });
    mkdirSync(resolve(unrelatedWorkspaceRoot, "packages/postgres/prisma/migrations"), { recursive: true });

    const artifacts = resolvePostgresPrismaRuntimeArtifacts({
      moduleUrl: pathToFileURL(resolve(installedPackageRoot, "dist/runtime-artifacts.js")),
      cwd: unrelatedWorkspaceRoot,
    });

    expect(artifacts.packageRoot).toBe(installedPackageRoot);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "friday-relay-postgres-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}
