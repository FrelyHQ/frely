import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const adminRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(adminRoot, "../..");
const adminPackage = JSON.parse(readFileSync(path.join(adminRoot, "package.json"), "utf8")) as { version: string };
const buildOutputRoot = path.resolve(
  process.env.FRIDAY_RELAY_ADMIN_BUILD_OUT_DIR ?? path.join(adminRoot, ".output/raw"),
);

export default defineConfig({
  root: adminRoot,
  define: {
    __FRIDAY_RELAY_ADMIN_VERSION__: JSON.stringify(adminPackage.version),
  },
  plugins: [
    {
      name: "friday-relay-server-only",
      enforce: "pre",
      resolveId(source) {
        if (source === "server-only" && this.environment.config.consumer === "server") {
          return path.join(adminRoot, "src/server-only-empty.server.ts");
        }
      },
    },
    tanstackStart({
      srcDirectory: "src",
      start: { entry: "start.ts" },
      router: {
        entry: "router.tsx",
        routesDirectory: path.join(adminRoot, "src/routes"),
        generatedRouteTree: path.join(adminRoot, "src/routeTree.gen.ts"),
        routeFileIgnorePattern: "\\.(?:test|spec)\\.",
      },
      server: { entry: "server.ts" },
      serverFns: { disableCsrfMiddlewareWarning: true },
      importProtection: {
        enabled: true,
        behavior: "error",
        client: {
          specifiers: [/^node:/, "server-only", "@frely/observability/instrumentation"],
          files: [/\.server\.[cm]?[jt]sx?$/],
        },
        server: { files: [/\.client\.[cm]?[jt]sx?$/] },
      },
    }),
    react(),
  ],
  resolve: {
    alias: [
      { find: "@admin", replacement: path.join(adminRoot, "src") },
      { find: /^@frely\/observability\/client-runtime$/, replacement: path.join(workspaceRoot, "packages/observability/src/client-runtime.ts") },
      { find: /^@frely\/observability\/contracts$/, replacement: path.join(workspaceRoot, "packages/observability/src/contracts.ts") },
      { find: /^@frely\/observability\/generated-dialog-registry$/, replacement: path.join(workspaceRoot, "packages/observability/src/generated-dialog-registry.ts") },
      { find: /^@frely\/observability\/instrumentation$/, replacement: path.join(workspaceRoot, "packages/observability/src/instrumentation.ts") },
      { find: /^@frely\/observability\/server$/, replacement: path.join(workspaceRoot, "packages/observability/src/server.ts") },
      { find: /^@frely\/observability$/, replacement: path.join(workspaceRoot, "packages/observability/src/index.ts") },
    ],
    dedupe: ["react", "react-dom"],
  },
  ssr: {
    external: ["@dsnp/parquetjs", "thrift"],
    noExternal: true,
  },
  build: {
    outDir: buildOutputRoot,
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: "es2022",
    rolldownOptions: {
      external: ["thrift"],
    },
  },
});
