import { createEgressProxy } from "./proxy.js";
import { loadCliProxyEgressRuntimeConfig } from "./runtime-config.js";

const runtime = loadCliProxyEgressRuntimeConfig();
const server = createEgressProxy({ allowedPorts: runtime.allowedPorts, ...(runtime.privateProviderOrigin ? { privateProviderOrigin: runtime.privateProviderOrigin } : {}) });
server.listen(runtime.port, "0.0.0.0");

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
