import { loadCliProxyControlRuntimeConfig } from "./runtime-config.js";
import { CredentialStore } from "./store.js";

if (process.argv[2] !== "runtime-config-check") {
  throw new Error("Usage: bun dist/cli.js runtime-config-check");
}

const config = loadCliProxyControlRuntimeConfig();
const store = new CredentialStore(config.storePath, config.storeKey);
await store.load();
console.log("CLIProxy Control runtime config check passed");
