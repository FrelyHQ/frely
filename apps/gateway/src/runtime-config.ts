import {
  assertCliProxyInferenceConfig,
  CliProxyControlClient,
  cpaConnectionEntry,
  DEFAULT_CPA_INSTANCE_ID,
  loadCpaConnectionRegistry,
  loadCliProxyConfig,
  readCpaSecret
} from "@frely/providers";

export function validateGatewayRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") throw new Error("gateway_node_environment_must_be_production");
  if ((environment.FRIDAY_RELAY_GATEWAY_MODE ?? "core") !== "core") throw new Error("gateway_edge_relay_mode_not_admitted");
  const registry = loadCpaConnectionRegistry(environment);
  if (registry) {
    const entry = cpaConnectionEntry(registry, DEFAULT_CPA_INSTANCE_ID);
    readCpaSecret(entry.inferenceKeyFile, "inference");
    CliProxyControlClient.fromEnv(environment);
    return;
  }
  const cliProxy = loadCliProxyConfig(environment, { production: true });
  assertCliProxyInferenceConfig(cliProxy);
  CliProxyControlClient.fromEnv(environment);
}
