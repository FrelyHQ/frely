import { loadConfig } from "@frely/config";
import { createPostgresPiTunnelDeviceRuntime } from "@frely/pi-tunnel";
import { createPiTunnelServer } from "./server.js";

const config = await loadConfig();
if (!config.piTunnel.enabled) throw new Error("pi_tunnel_disabled");
const deviceRuntime = createPostgresPiTunnelDeviceRuntime();
const runtime = createPiTunnelServer(config.piTunnel, {
  repository: deviceRuntime.repository,
});

await runtime.listen();

async function shutdown(): Promise<void> {
  await runtime.close().catch(() => undefined);
  await deviceRuntime.close().catch(() => undefined);
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
