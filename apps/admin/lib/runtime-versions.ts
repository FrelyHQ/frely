import { CliProxyControlClient, type CliProxyControlRuntimeIdentity } from "@frely/providers";
import { ADMIN_VERSION } from "./admin-version";

const DEFAULT_CLIPROXY_API_IMAGE = "friday-relay-cli-proxy-api:latest";
const EXPECTED_CLIPROXY_VERSION = "v7.2.145";
const EXPECTED_CLIPROXY_COMMIT = "d9cea89";
const EXPECTED_CLIPROXY_EVIDENCE_CONTRACT = "cpa-basic@1";
const EXPECTED_CLIPROXY_ADAPTATION = "friday-evidence-v1";
const UNKNOWN_RUNTIME_VERSION = "unknown";

export interface RuntimeVersion {
  service: "User Console" | "Admin" | "Gateway" | "CLIProxyAPI Running binary" | "CLIProxyAPI Configured image";
  version: string;
  detail: string;
  availability: "running" | "configured" | "unavailable" | "error";
}

interface VersionHealthResponse {
  service?: unknown;
  version?: unknown;
}

export async function runtimeVersions(options: {
  fetchImplementation?: typeof fetch;
  gatewayBaseUrl?: string;
  webBaseUrl?: string;
  gatewayFallbackVersion?: string;
  webFallbackVersion?: string;
  cliProxyApiImage?: string;
  cliProxyRuntimeIdentity?: () => Promise<CliProxyControlRuntimeIdentity>;
} = {}): Promise<RuntimeVersion[]> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const gatewayBaseUrl = options.gatewayBaseUrl ?? process.env.FRIDAY_RELAY_GATEWAY_INTERNAL_BASE_URL ?? "http://gateway-srv:43000";
  const webBaseUrl = options.webBaseUrl ?? process.env.FRIDAY_RELAY_WEB_INTERNAL_BASE_URL ?? "http://web:43001";
  const gatewayFallbackVersion = configuredRuntimeVersion(
    options.gatewayFallbackVersion,
    "FRIDAY_RELAY_GATEWAY_VERSION",
    "FRIDAY_RELAY_GATEWAY_IMAGE",
  );
  const webFallbackVersion = configuredRuntimeVersion(
    options.webFallbackVersion,
    "FRIDAY_RELAY_WEB_VERSION",
    "FRIDAY_RELAY_WEB_IMAGE",
  );
  const cliProxyApiImage = options.cliProxyApiImage ?? process.env.FRIDAY_RELAY_CLIPROXY_API_IMAGE ?? DEFAULT_CLIPROXY_API_IMAGE;
  const cliProxyRuntimeIdentity = options.cliProxyRuntimeIdentity ?? (() => CliProxyControlClient.fromEnv().runtimeIdentity());
  const [web, gateway, cliProxy] = await Promise.all([
    runningVersion("User Console", webBaseUrl, "/api/health", webFallbackVersion, fetchImplementation),
    runningVersion("Gateway", gatewayBaseUrl, "/health", gatewayFallbackVersion, fetchImplementation),
    runningCliProxyVersion(cliProxyRuntimeIdentity)
  ]);

  return [
    web,
    {
      service: "Admin",
      version: ADMIN_VERSION,
      detail: "This Admin instance",
      availability: "running"
    },
    gateway,
    cliProxy,
    { service: "CLIProxyAPI Configured image", ...cliProxyApiImageVersion(cliProxyApiImage), availability: "configured" }
  ];
}

function configuredRuntimeVersion(explicitVersion: string | undefined, versionEnv: string, imageEnv: string): string {
  const configuredVersion = explicitVersion ?? process.env[versionEnv];
  if (typeof configuredVersion === "string" && configuredVersion.trim()) return configuredVersion;
  const image = process.env[imageEnv];
  if (typeof image === "string" && image.trim()) {
    const imageVersion = cliProxyApiImageVersion(image).version;
    return imageVersion.startsWith("pkg-") ? imageVersion.slice("pkg-".length) : imageVersion;
  }
  return UNKNOWN_RUNTIME_VERSION;
}

async function runningCliProxyVersion(readIdentity: () => Promise<CliProxyControlRuntimeIdentity>): Promise<RuntimeVersion> {
  try {
    const identity = await readIdentity();
    const matches = identity.version === EXPECTED_CLIPROXY_VERSION
      && identity.commit === EXPECTED_CLIPROXY_COMMIT
      && identity.evidenceContract === EXPECTED_CLIPROXY_EVIDENCE_CONTRACT
      && identity.adaptation === EXPECTED_CLIPROXY_ADAPTATION;
    return {
      service: "CLIProxyAPI Running binary",
      version: identity.version,
      detail: matches
        ? `Commit ${identity.commit}; ${identity.evidenceContract}; ${identity.adaptation}; built ${identity.buildDate}`
        : `Expected ${EXPECTED_CLIPROXY_VERSION} / ${EXPECTED_CLIPROXY_COMMIT} / ${EXPECTED_CLIPROXY_EVIDENCE_CONTRACT}; reported ${identity.version} / ${identity.commit} / ${identity.evidenceContract}`,
      availability: matches ? "running" : "error"
    };
  } catch {
    return {
      service: "CLIProxyAPI Running binary",
      version: "unavailable",
      detail: "Authenticated Control runtime identity is unavailable",
      availability: "unavailable"
    };
  }
}

async function runningVersion(
  service: "User Console" | "Gateway",
  baseUrl: string,
  healthPath: string,
  fallbackVersion: string,
  fetchImplementation: typeof fetch
): Promise<RuntimeVersion> {
  try {
    const response = await fetchImplementation(new URL(healthPath, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error("health check failed");
    const payload = await response.json() as VersionHealthResponse;
    if (typeof payload.version !== "string" || !payload.version) throw new Error("version missing");
    return { service, version: payload.version, detail: "Running instance", availability: "running" };
  } catch {
    return {
      service,
      version: fallbackVersion,
      detail: fallbackVersion === UNKNOWN_RUNTIME_VERSION
        ? "Runtime health check unavailable; configured version is unknown"
        : "Runtime health check unavailable; configured version",
      availability: "unavailable"
    };
  }
}

export function cliProxyApiImageVersion(image: string): Pick<RuntimeVersion, "version" | "detail"> {
  const imageWithoutDigest = image.split("@")[0] ?? image;
  const lastSlash = imageWithoutDigest.lastIndexOf("/");
  const tagSeparator = imageWithoutDigest.lastIndexOf(":");
  const version = tagSeparator > lastSlash ? imageWithoutDigest.slice(tagSeparator + 1) : "digest-pinned";
  const digest = image.match(/@sha256:([a-f0-9]{12,})$/i)?.[1];
  return {
    version,
    detail: digest ? `Pinned image sha256:${digest.slice(0, 12)}` : "Configured image tag"
  };
}
