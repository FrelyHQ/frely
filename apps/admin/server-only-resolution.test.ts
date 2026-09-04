import path from "node:path";
import { describe, expect, test } from "vitest";
import adminViteConfig from "./vite.config.mjs";

type ServerOnlyResolver = {
  name?: string;
  resolveId?: (this: {
    environment: { config: { consumer: string } };
  }, source: string) => unknown;
};

describe("Admin Vite server-only resolution", () => {
  test("replaces the marker only for the server consumer", () => {
    const plugins = flattenPlugins(adminViteConfig.plugins);
    const resolver = plugins.find((plugin) => plugin.name === "friday-relay-server-only");
    expect(resolver).toBeDefined();
    expect(typeof resolver?.resolveId).toBe("function");

    const resolveId = resolver?.resolveId;
    if (!resolveId) throw new Error("server-only resolver is missing");
    const serverTarget = resolveId.call(
      { environment: { config: { consumer: "server" } } },
      "server-only",
    );
    const clientTarget = resolveId.call(
      { environment: { config: { consumer: "client" } } },
      "server-only",
    );

    expect(serverTarget).toBe(path.join(import.meta.dirname, "src/server-only-empty.server.ts"));
    expect(clientTarget).toBeUndefined();
    expect(JSON.stringify(adminViteConfig.resolve?.alias ?? [])).not.toContain("server-only");
  });
});

function flattenPlugins(value: unknown): ServerOnlyResolver[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (
    Array.isArray(entry) ? flattenPlugins(entry) : [entry as ServerOnlyResolver]
  ));
}
