import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const routesDirectory = path.dirname(fileURLToPath(import.meta.url));

const acceptedPageRoutes = [
  "/",
  "/owner",
  "/owner/access-points",
  "/owner/account/security",
  "/owner/audit-logs",
  "/owner/authority-products",
  "/owner/budget-managers",
  "/owner/budget-policies",
  "/owner/credits",
  "/owner/keys",
  "/owner/operations/card-activations",
  "/owner/operations/grants",
  "/owner/plans",
  "/owner/plans-and-budgets/budget-policies",
  "/owner/plans-and-budgets/governance-budgets",
  "/owner/plans-and-budgets/plan-purchases",
  "/owner/plans-and-budgets/plans",
  "/owner/plans/subscriptions",
  "/owner/plans/subscriptions/$subscriptionId",
  "/owner/pricing",
  "/owner/providers",
  "/owner/request-logs",
  "/owner/system-settings",
  "/owner/teams",
  "/owner/teams/$teamId",
  "/owner/tools/access-resolution",
  "/owner/tools/api-test",
  "/owner/users",
  "/owner/users/$userId",
  "/owner/users/$userId/api-keys/$keyId",
  "/owner/users/$userId/request-history",
].sort();

describe("Admin Start page inventory", () => {
  test("keeps one Start page owner for each of the accepted 31 public URLs", async () => {
    const routeFiles = (await readdir(routesDirectory))
      .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx") && file !== "__root.tsx");
    const layoutOwners = new Set(routeFiles
      .filter((file) => file.endsWith(".index.tsx"))
      .map((file) => file.replace(/\.index\.tsx$/u, ".tsx"))
      .filter((file) => routeFiles.includes(file)));
    const pageFiles = routeFiles.filter((file) => !layoutOwners.has(file));
    const routes = await Promise.all(pageFiles.map(async (file) => {
      const source = await readFile(path.join(routesDirectory, file), "utf8");
      const route = source.match(/createFileRoute\("([^"]+)"\)/)?.[1] ?? null;
      return route && route !== "/" ? route.replace(/\/$/, "") : route;
    }));

    expect(routes).not.toContain(null);
    expect(routes.sort()).toEqual(acceptedPageRoutes);
  });
});
