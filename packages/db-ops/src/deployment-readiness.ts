import type { AccessPoint, Provider, ProviderBinding, ProviderModel } from "@frely/application/runtime";

export interface DeploymentReadinessReport {
  enabledProviderCount: number;
  readyProviderCount: number;
  unreadyProviders: Array<{
    providerId: string;
    reason: "binding_missing" | "binding_not_ready" | "enabled_model_missing";
  }>;
  enabledProviderModelCount: number;
  enabledAccessPointCount: number;
  blockedProviderAccessPointIds: string[];
  callableProviderAccessPointCount: number;
  privateProviderOrigin: {
    required: boolean;
    configured: boolean;
    status: "not_required" | "missing" | "mismatch" | "ready";
    distinctRequiredOriginCount: number;
  };
  providerCanaryReady: boolean;
}

export interface AsyncDeploymentReadinessApplicationOperationPort {
  listProviders(): Promise<Provider[]>;
  listProviderModels(): Promise<ProviderModel[]>;
  listAccessPoints(): Promise<AccessPoint[]>;
  getProviderBinding(providerId: string): Promise<ProviderBinding | undefined>;
}

export async function inspectAsyncDeploymentReadiness(
  repository: AsyncDeploymentReadinessApplicationOperationPort,
  input: { privateProviderOrigin?: string | undefined } = {},
): Promise<DeploymentReadinessReport> {
  const [providers, models, accessPoints] = await Promise.all([
    repository.listProviders(),
    repository.listProviderModels(),
    repository.listAccessPoints(),
  ]);
  const enabledProviders = providers.filter((provider) => provider.status === "enabled");
  const bindings = (await Promise.all(enabledProviders.map((provider) => repository.getProviderBinding(provider.id))))
    .filter((binding): binding is ProviderBinding => Boolean(binding));
  return buildDeploymentReadinessReport({
    providers,
    enabledModels: models.filter((model) => model.status === "enabled"),
    bindings,
    enabledAccessPoints: accessPoints
      .filter((accessPoint) => accessPoint.status === "enabled")
      .map(({ id, targetProviderId }) => ({ id, targetProviderId })),
  }, input);
}

function buildDeploymentReadinessReport(
  data: {
    providers: Array<{ id: string; status: string; configJson: string }>;
    enabledModels: Array<{ providerId: string }>;
    bindings: Array<{ providerId: string; syncStatus: string }>;
    enabledAccessPoints: Array<{ id: string; targetProviderId: string | null }>;
  },
  input: { privateProviderOrigin?: string | undefined },
): DeploymentReadinessReport {
  const { providers, enabledModels, bindings, enabledAccessPoints } = data;
  const enabledProviders = providers.filter((provider) => provider.status === "enabled");
  const enabledModelProviderIds = new Set(enabledModels.map((model) => model.providerId));
  const bindingByProviderId = new Map(bindings.map((binding) => [binding.providerId, binding]));

  const unreadyProviders: DeploymentReadinessReport["unreadyProviders"] = [];
  const readyProviderIds = new Set<string>();
  for (const provider of enabledProviders) {
    const binding = bindingByProviderId.get(provider.id);
    if (!binding) {
      unreadyProviders.push({ providerId: provider.id, reason: "binding_missing" });
    } else if (binding.syncStatus !== "ready") {
      unreadyProviders.push({ providerId: provider.id, reason: "binding_not_ready" });
    } else if (!enabledModelProviderIds.has(provider.id)) {
      unreadyProviders.push({ providerId: provider.id, reason: "enabled_model_missing" });
    } else {
      readyProviderIds.add(provider.id);
    }
  }

  const providerBackedAccessPoints = enabledAccessPoints.filter(
    (accessPoint): accessPoint is { id: string; targetProviderId: string } =>
      typeof accessPoint.targetProviderId === "string" && accessPoint.targetProviderId.length > 0,
  );
  const blockedProviderAccessPointIds = providerBackedAccessPoints
    .filter((accessPoint) => !readyProviderIds.has(accessPoint.targetProviderId))
    .map((accessPoint) => accessPoint.id);
  const callableProviderAccessPointCount = providerBackedAccessPoints.length
    - blockedProviderAccessPointIds.length;

  const requiredPrivateOrigins = new Set(
    enabledProviders
      .map((provider) => providerPrivateOrigin(provider.configJson))
      .filter((origin): origin is string => Boolean(origin)),
  );
  const configuredPrivateOrigin = normalizePrivateOrigin(input.privateProviderOrigin);
  let privateOriginStatus: DeploymentReadinessReport["privateProviderOrigin"]["status"];
  if (requiredPrivateOrigins.size === 0) {
    privateOriginStatus = "not_required";
  } else if (!configuredPrivateOrigin) {
    privateOriginStatus = "missing";
  } else if (requiredPrivateOrigins.size !== 1 || !requiredPrivateOrigins.has(configuredPrivateOrigin)) {
    privateOriginStatus = "mismatch";
  } else {
    privateOriginStatus = "ready";
  }

  return {
    enabledProviderCount: enabledProviders.length,
    readyProviderCount: readyProviderIds.size,
    unreadyProviders,
    enabledProviderModelCount: enabledModels.length,
    enabledAccessPointCount: enabledAccessPoints.length,
    blockedProviderAccessPointIds,
    callableProviderAccessPointCount,
    privateProviderOrigin: {
      required: requiredPrivateOrigins.size > 0,
      configured: Boolean(configuredPrivateOrigin),
      status: privateOriginStatus,
      distinctRequiredOriginCount: requiredPrivateOrigins.size,
    },
    providerCanaryReady: callableProviderAccessPointCount > 0,
  };
}

function providerPrivateOrigin(configJson: string): string | null {
  let config: unknown;
  try {
    config = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const baseUrl = (config as Record<string, unknown>).baseUrl;
  return normalizePrivateOrigin(typeof baseUrl === "string" ? baseUrl : undefined);
}

function normalizePrivateOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !parsed.port
    || !isTailscaleIpv4(parsed.hostname)
  ) {
    return null;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "/v1" && parsed.pathname !== "/v1/") return null;
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

function isTailscaleIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100
    && octets[1]! >= 64
    && octets[1]! <= 127;
}
