import { loadCliProxyEgressRuntimeConfig } from "./runtime-config.js";

if (process.argv[2] !== "runtime-config-check") {
  throw new Error("Usage: bun dist/cli.js runtime-config-check");
}

loadCliProxyEgressRuntimeConfig();
console.log("CLIProxy egress runtime config check passed");
