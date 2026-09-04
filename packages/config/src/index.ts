import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { domainToASCII } from "node:url";
import { getDomain } from "tldts";
import { z } from "zod";
import type { RuntimeEnvironment } from "@frely/core";

const DEPRECATED_GATEWAY_CONFIG_FIELDS = ["requestTimeoutMs", "streamIdleTimeoutMs", "maxEstimatedTokens"] as const;
let deprecatedGatewayConfigWarningEmitted = false;
let deprecatedOidcCanonicalIpWarningEmitted = false;

const providerConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}).superRefine((config, context) => {
    for (const key of ["apiKey", "api_key"]) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Provider API keys are not allowed in provider config"
        });
      }
    }
    if (Object.prototype.hasOwnProperty.call(config, "credential")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential"],
        message: "Provider credentials are not allowed in provider config"
      });
    }
  })
}).strict();

const requestCaptureDownloadSchema = z.object({
  maxFiles: z.number().int().min(1).max(100_000).default(10_000),
  maxCompressedBytes: z.number().int().min(1_048_576).default(1_073_741_824)
}).strict();

const requestCaptureStorageSchema = z.object({
  hotDays: z.number().int().min(1).default(90),
  archive: z.object({
    enabled: z.boolean().default(true),
    autoPurge: z.boolean().default(true),
    purgeBatchSize: z.number().int().min(1).max(1000).default(200),
    zstdLevel: z.number().int().min(1).max(19).default(6),
    frameUncompressedBytes: z.number().int().min(1_048_576).max(67_108_864).default(67_108_864)
  }).strict().default({}),
  download: requestCaptureDownloadSchema.default({})
}).strict();

const requestHistoryArchiveSchema = z.object({
  enabled: z.boolean().default(true),
  autoPurge: z.boolean().default(true),
  hotDays: z.number().int().min(1).default(180),
  purgeBatchSize: z.number().int().min(1).max(1000).default(200)
}).strict();

const requestExecutionSchema = z.object({
  leaseTtlSeconds: z.number().int().min(60).max(86_400).default(1_800),
  staleAfterSeconds: z.number().int().min(60).max(86_400 * 30).default(86_400)
}).strict();

const oidcSigningKeySchema = z.object({
  kid: z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  privateKeyFile: z.string().min(1).optional(),
  publicKeyFile: z.string().min(1).optional()
}).strict().superRefine((key, context) => {
  if (!key.privateKeyFile && !key.publicKeyFile) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An OIDC signing key requires privateKeyFile or publicKeyFile" });
  }
});

const oidcDisabledSchema = z.object({
  enabled: z.literal(false)
}).strict();

const oidcClientSchema = z.object({
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  displayName: z.string().min(1).max(100),
  profile: z.literal("identity-only").optional(),
  clientSecretFile: z.string().min(1),
  redirectUris: z.array(z.string().url()).min(1).max(8)
}).strict();

const oidcEnabledSchema = z.object({
  enabled: z.literal(true),
  issuer: z.string().url(),
  clients: z.array(oidcClientSchema).min(1).max(16),
  interactionSecretFile: z.string().min(1),
  codeTtlSeconds: z.number().int().min(1).max(300).default(60),
  accessTokenTtlSeconds: z.number().int().min(1).max(900).default(300),
  idTokenTtlSeconds: z.number().int().min(1).max(900).default(300),
  activeSigningKeyId: z.string().min(1).max(128),
  signingKeys: z.array(oidcSigningKeySchema).min(1).max(8),
  canonicalClientIpHeader: z.literal("x-real-ip").optional()
}).strict();

const oidcConfigSchema = z.discriminatedUnion("enabled", [oidcDisabledSchema, oidcEnabledSchema]);

const passkeyDisabledSchema = z.object({
  enabled: z.literal(false)
}).strict();

const passkeyEnabledSchema = z.object({
  enabled: z.literal(true),
  surfaces: z.object({
    web: z.object({
      origin: z.string().url(),
      rpId: z.string().min(1).max(253)
    }).strict(),
    admin: z.object({
      origin: z.string().url(),
      rpId: z.string().min(1).max(253)
    }).strict().optional()
  }).strict()
}).strict();

const passkeyConfigSchema = z.discriminatedUnion("enabled", [passkeyDisabledSchema, passkeyEnabledSchema]);

const piTunnelDisabledSchema = z.object({
  enabled: z.literal(false)
}).strict();

const piTunnelEnabledSchema = z.object({
  enabled: z.literal(true),
  mode: z.literal("single-instance"),
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(1).max(65_535),
  maxConnections: z.number().int().min(1).max(100_000).default(1_024),
  maxControlBytes: z.number().int().min(512).max(65_536).default(8_192),
  maxFrameBytes: z.number().int().min(1_024).max(16_777_216).default(1_048_576),
  bufferedHighWaterBytes: z.number().int().min(65_536).max(67_108_864).default(4_194_304),
  bufferedAbsoluteBytes: z.number().int().min(131_072).max(134_217_728).default(16_777_216),
  maxQueuedFrames: z.number().int().min(1).max(100_000).default(4_096),
  handshakeTimeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  heartbeatIntervalMs: z.number().int().min(1_000).max(120_000).default(15_000),
  idleTimeoutMs: z.number().int().min(5_000).max(3_600_000).default(120_000),
  hardLifetimeMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
  nodeRevocationPollMs: z.number().int().min(1_000).max(300_000).default(30_000),
  activationRateLimitPerMinute: z.number().int().min(1).max(1_000).default(60)
}).strict();

const piTunnelConfigSchema = z.discriminatedUnion("enabled", [piTunnelDisabledSchema, piTunnelEnabledSchema]);

export const appConfigSchema = z.object({
  app: z.object({
    name: z.string().min(1),
    environment: z.enum(["development", "production", "test"]),
    publicBaseUrl: z.string().url(),
    reservedHostnames: z.array(z.string().min(1)).default([])
  }),
  database: z.object({
    backend: z.literal("postgres").default("postgres")
  }).strict(),
  archive: z.object({
    directory: z.string().min(1).default("./archives"),
    // Shared storage is required only when multiple application instances need
    // cross-instance file visibility; it is independent of the database backend.
    shared: z.boolean().optional(),
    sharedStorageId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
    coldDirectory: z.string().min(1).optional(),
    requireColdMount: z.boolean().default(true),
    history: requestHistoryArchiveSchema.default({})
  }).strict().default({}),
  requestCapture: requestCaptureStorageSchema.default({}),
  requestExecution: requestExecutionSchema.default({}),
  security: z.object({
    abuseRateLimit: z.object({
      canonicalClientIpHeader: z.enum(["x-real-ip", "cf-connecting-ip"]).optional()
    }).strict().default({})
  }).strict().default({}),
  auth: z.object({
    accessTokenTtlSeconds: z.number().int().positive(),
    refreshTokenTtlSeconds: z.number().int().positive(),
    jwtSecret: z.string().min(16),
    cookieSecure: z.boolean().default(false),
    passkey: passkeyConfigSchema.default({ enabled: false })
  }),
  oidc: oidcConfigSchema.optional(),
  web: z.object({
    host: z.string().min(1),
    port: z.number().int().positive()
  }),
  admin: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    passkey: z.never().optional()
  }),
  gateway: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    maxRequestBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ingressRouteAttestationMode: z.enum(["observe", "required"]).default("observe")
  }),
  piTunnel: piTunnelConfigSchema.default({ enabled: false }),
  providers: z.array(providerConfigSchema),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    redactKeys: z.array(z.string()).default([])
  }),
  bootstrap: z.object({
    enabled: z.boolean().default(true),
    ownerEmail: z.string().email()
  })
}).superRefine((config, context) => {
  if (config.archive.shared === true && !config.archive.sharedStorageId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "sharedStorageId"], message: "Shared Capture storage requires a stable storage id" });
  }
  if (config.archive.shared !== true && config.archive.sharedStorageId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "sharedStorageId"], message: "Shared Capture storage id requires archive.shared" });
  }
  if (config.app.environment === "production" && config.requestCapture.hotDays !== 90) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestCapture", "hotDays"], message: "Production Request Capture hot retention must be 90 days" });
  }
  if (config.app.environment === "production" && config.archive.history.hotDays !== 180) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "history", "hotDays"], message: "Production request history hot retention must be 180 days" });
  }
  if (config.requestCapture.archive.autoPurge && !config.requestCapture.archive.enabled) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestCapture", "archive", "autoPurge"], message: "Request Capture auto purge requires the monthly archive" });
  }
  if (config.requestCapture.archive.enabled && !config.archive.coldDirectory) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "coldDirectory"], message: "Request Capture monthly archive requires a cold directory" });
  }
  if (config.archive.history.autoPurge && !config.archive.history.enabled) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "history", "autoPurge"], message: "Request history auto purge requires the monthly archive" });
  }
  if (config.archive.history.enabled && !config.archive.coldDirectory) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "coldDirectory"], message: "Request history archive requires a cold directory" });
  }
  if (config.app.environment === "production" && config.archive.history.autoPurge && !config.archive.requireColdMount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "requireColdMount"], message: "Production Request history purge requires mount identity verification" });
  }
  if (config.app.environment === "production" && config.requestCapture.archive.enabled && !config.archive.requireColdMount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["archive", "requireColdMount"], message: "Production Request Capture archive requires mount identity verification" });
  }
  if (config.piTunnel.enabled) {
    if (config.app.environment === "production") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["piTunnel", "enabled"], message: "Pi Tunnel phase 1 has no production topology and must remain disabled in production" });
    }
    if (config.piTunnel.bufferedHighWaterBytes < config.piTunnel.maxFrameBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["piTunnel", "bufferedHighWaterBytes"], message: "Pi Tunnel buffered high-water limit must cover one maximum frame" });
    }
    if (config.piTunnel.bufferedAbsoluteBytes <= config.piTunnel.bufferedHighWaterBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["piTunnel", "bufferedAbsoluteBytes"], message: "Pi Tunnel absolute buffered limit must exceed the high-water limit" });
    }
    if (config.piTunnel.idleTimeoutMs <= config.piTunnel.heartbeatIntervalMs) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["piTunnel", "idleTimeoutMs"], message: "Pi Tunnel idle timeout must exceed the heartbeat interval" });
    }
    if (config.piTunnel.hardLifetimeMs <= config.piTunnel.idleTimeoutMs) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["piTunnel", "hardLifetimeMs"], message: "Pi Tunnel hard lifetime must exceed the idle timeout" });
    }
  }
  const oidc = config.oidc;
  const publicBaseUrl = safeUrl(config.app.publicBaseUrl);
  if (oidc?.enabled) {
  context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "enabled"], message: "OIDC authentication is retired; set oidc.enabled to false" });
  const issuer = safeUrl(oidc.issuer);
  if (!issuer || issuer.pathname !== "/" || issuer.search || issuer.hash || oidc.issuer.endsWith("/")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "issuer"], message: "OIDC issuer must be an origin URL without a trailing slash, path, query, or fragment" });
  }
  if (issuer && publicBaseUrl && issuer.origin !== publicBaseUrl.origin) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "issuer"], message: "OIDC issuer must match app.publicBaseUrl origin" });
  }
  if (config.app.environment === "production" && issuer?.protocol !== "https:") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "issuer"], message: "Production OIDC issuer must use HTTPS" });
  }
  if (config.app.environment !== "test" && oidc.codeTtlSeconds < 30) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "codeTtlSeconds"], message: "OIDC authorization code TTL must be at least 30 seconds outside tests" });
  }
  if (config.app.environment !== "test" && oidc.accessTokenTtlSeconds < 60) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "accessTokenTtlSeconds"], message: "OIDC access token TTL must be at least 60 seconds outside tests" });
  }
  if (config.app.environment !== "test" && oidc.idTokenTtlSeconds < 60) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "idTokenTtlSeconds"], message: "OIDC ID token TTL must be at least 60 seconds outside tests" });
  }
  if (config.app.environment === "production" && !config.security.abuseRateLimit.canonicalClientIpHeader && oidc.canonicalClientIpHeader !== "x-real-ip") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["security", "abuseRateLimit", "canonicalClientIpHeader"], message: "Production OIDC requires an explicitly trusted canonical client IP proxy header" });
  }
  const clientIds = oidc.clients.map((client) => client.clientId);
  if (new Set(clientIds).size !== clientIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "clients"], message: "OIDC client ids must be unique" });
  }
  for (const [clientIndex, client] of oidc.clients.entries()) {
    if (new Set(client.redirectUris).size !== client.redirectUris.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "clients", clientIndex, "redirectUris"], message: "OIDC redirect URIs must be unique within a client profile" });
    }
    for (const [redirectIndex, redirectUri] of client.redirectUris.entries()) {
      const parsed = safeUrl(redirectUri);
      const isLoopbackHttp = parsed?.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "localhost");
      if (!parsed || parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && !isLoopbackHttp)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "clients", clientIndex, "redirectUris", redirectIndex], message: "OIDC redirect URI must use HTTPS or loopback HTTP and cannot contain credentials or a fragment" });
      }
      if (config.app.environment === "production" && parsed?.protocol !== "https:") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "clients", clientIndex, "redirectUris", redirectIndex], message: "Production OIDC redirect URI must use HTTPS" });
      }
    }
  }
  const keyIds = oidc.signingKeys.map((key) => key.kid);
  if (new Set(keyIds).size !== keyIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "signingKeys"], message: "OIDC signing key ids must be unique" });
  }
  const privateSecretPaths = [
    ...oidc.clients.map((client) => client.clientSecretFile),
    oidc.interactionSecretFile,
    ...oidc.signingKeys.flatMap((key) => key.privateKeyFile ? [key.privateKeyFile] : [])
  ];
  if (new Set(privateSecretPaths).size !== privateSecretPaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc"], message: "OIDC client, interaction, and signing private-key files must be distinct" });
  }
  const activeKey = oidc.signingKeys.find((key) => key.kid === oidc.activeSigningKeyId);
  if (!activeKey?.privateKeyFile) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["oidc", "activeSigningKeyId"], message: "Active OIDC signing key must exist and provide privateKeyFile" });
  }
  }
  const passkey = config.auth.passkey;
  if (passkey.enabled) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["auth", "passkey", "enabled"], message: "Passkey authentication is retired; set auth.passkey.enabled to false" });
    const surfaces = Object.entries(passkey.surfaces) as Array<["web" | "admin", { origin: string; rpId: string }]>;
    for (const [surface, surfaceConfig] of surfaces) {
      validatePasskeySurface(config, context, surface, surfaceConfig);
    }
    const webOrigin = safeUrl(passkey.surfaces.web.origin);
    if (webOrigin && publicBaseUrl && webOrigin.origin !== publicBaseUrl.origin) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["auth", "passkey", "surfaces", "web", "origin"], message: "Web Passkey origin must match app.publicBaseUrl origin" });
    }
    const adminOrigin = passkey.surfaces.admin ? safeUrl(passkey.surfaces.admin.origin) : null;
    if (adminOrigin && webOrigin && adminOrigin.origin === webOrigin.origin) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["auth", "passkey", "surfaces", "admin", "origin"], message: "Admin Passkey origin must be distinct from the Web origin" });
    }
    if (config.app.environment === "production" && adminOrigin && !config.app.reservedHostnames.includes(adminOrigin.hostname)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["auth", "passkey", "surfaces", "admin", "origin"], message: "Production Admin Passkey hostname must be reserved" });
    }
    if (config.app.environment === "production" && !config.auth.cookieSecure) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["auth", "cookieSecure"], message: "Production Passkey requires secure authentication cookies" });
    }
  }
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const defaultConfigFileName = "friday-relay.config.json";

function resolveConfigPath(path: string, configDirectory: string): string {
  return isAbsolute(path) ? path : resolve(configDirectory, path);
}

function resolveConfigPaths(config: AppConfig, configPath: string): AppConfig {
  const configDirectory = dirname(configPath);
  return {
    ...config,
    database: config.database,
    requestCapture: config.requestCapture,
    archive: {
      ...config.archive,
      directory: resolveConfigPath(config.archive.directory, configDirectory),
      ...(config.archive.coldDirectory ? { coldDirectory: resolveConfigPath(config.archive.coldDirectory, configDirectory) } : {})
    },
    ...(config.oidc?.enabled ? {
      oidc: {
        ...config.oidc,
        clients: config.oidc.clients.map((client) => ({
          ...client,
          clientSecretFile: resolveConfigPath(client.clientSecretFile, configDirectory)
        })),
        interactionSecretFile: resolveConfigPath(config.oidc.interactionSecretFile, configDirectory),
        signingKeys: config.oidc.signingKeys.map((key) => ({
          ...key,
          ...(key.privateKeyFile ? { privateKeyFile: resolveConfigPath(key.privateKeyFile, configDirectory) } : {}),
          ...(key.publicKeyFile ? { publicKeyFile: resolveConfigPath(key.publicKeyFile, configDirectory) } : {})
        }))
      }
    } : {}),
  };
}

async function findDefaultConfigPath(): Promise<string> {
  return resolve(process.cwd(), "data", defaultConfigFileName);
}

function findDefaultConfigPathSync(): string {
  return resolve(process.cwd(), "data", defaultConfigFileName);
}

export async function loadConfig(path = process.env.FRIDAY_RELAY_CONFIG): Promise<AppConfig> {
  const absolutePath = path ? resolve(path) : await findDefaultConfigPath();
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`${defaultConfigFileName} is required at ${absolutePath}: ${(error as Error).message}`);
  }
  return resolveConfigPaths(parseConfig(JSON.parse(raw)), absolutePath);
}

export function loadConfigSync(path = process.env.FRIDAY_RELAY_CONFIG): AppConfig {
  const absolutePath = path ? resolve(path) : findDefaultConfigPathSync();
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`${defaultConfigFileName} is required at ${absolutePath}: ${(error as Error).message}`);
  }
  return resolveConfigPaths(parseConfig(JSON.parse(raw)), absolutePath);
}

export function parseConfig(value: unknown): AppConfig {
  warnDeprecatedGatewayConfig(value);
  warnDeprecatedOidcCanonicalIpConfig(value);
  return appConfigSchema.parse(normalizeLegacyArchiveConfig(value));
}

/**
 * Accept one release of the retired requestLogArchive shape so existing
 * workspaces can be upgraded without silently disabling history retention.
 * The parsed AppConfig never exposes the legacy key again.
 */
function normalizeLegacyArchiveConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const legacy = input.requestLogArchive;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return value;
  const archive = input.archive && typeof input.archive === "object" && !Array.isArray(input.archive)
    ? { ...(input.archive as Record<string, unknown>) }
    : {};
  const history = archive.history && typeof archive.history === "object" && !Array.isArray(archive.history)
    ? { ...(archive.history as Record<string, unknown>) }
    : {};
  const legacyRecord = legacy as Record<string, unknown>;
  for (const key of ["enabled", "autoPurge", "hotDays", "purgeBatchSize"] as const) {
    if (history[key] === undefined && legacyRecord[key] !== undefined) history[key] = legacyRecord[key];
  }
  archive.history = history;
  const requestExecution = input.requestExecution && typeof input.requestExecution === "object" && !Array.isArray(input.requestExecution)
    ? { ...(input.requestExecution as Record<string, unknown>) }
    : {};
  const reconciliation = legacyRecord.reconciliation;
  if (requestExecution.leaseTtlSeconds === undefined && reconciliation && typeof reconciliation === "object" && !Array.isArray(reconciliation)) {
    requestExecution.leaseTtlSeconds = (reconciliation as Record<string, unknown>).leaseTtlSeconds;
  }
  const { requestLogArchive: _removed, ...withoutLegacy } = input;
  return { ...withoutLegacy, archive, requestExecution };
}

export function runtimeEnvironment(config: AppConfig): RuntimeEnvironment {
  return config.app.environment;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isCanonicalHostname(value: string): boolean {
  if (value.startsWith(".") || value.endsWith(".") || value.includes("*") || value.includes("..")) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function validatePasskeySurface(
  config: Pick<AppConfig, "app">,
  context: z.RefinementCtx,
  surface: "web" | "admin",
  surfaceConfig: { origin: string; rpId: string }
): void {
  const path = ["auth", "passkey", "surfaces", surface] as const;
  const origin = safeUrl(surfaceConfig.origin);
  const rpId = domainToASCII(surfaceConfig.rpId).toLowerCase();
  if (!origin || origin.origin !== surfaceConfig.origin || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "origin"], message: "Passkey origin must be an exact origin without credentials, path, query, fragment, or trailing slash" });
  }
  if (!rpId || rpId !== surfaceConfig.rpId || !isCanonicalHostname(rpId) || isIP(rpId) !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "rpId"], message: "Passkey RP ID must be a normalized lowercase ASCII hostname" });
  }
  if (origin && rpId && origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "rpId"], message: "Passkey RP ID must equal or be a registrable-domain suffix of the origin hostname" });
  }
  const isLocalhostHttp = config.app.environment !== "production" && origin?.protocol === "http:" && origin.hostname === "localhost" && rpId === "localhost";
  if (origin && origin.protocol !== "https:" && !isLocalhostHttp) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "origin"], message: "Passkey origin must use HTTPS or non-production localhost HTTP" });
  }
  if (rpId !== "localhost" && getDomain(rpId, { allowPrivateDomains: true }) === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "rpId"], message: "Passkey RP ID must contain a registrable domain and cannot be a public or private suffix" });
  }
  if (config.app.environment === "production" && (origin?.protocol !== "https:" || rpId === "localhost")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "origin"], message: "Production Passkey surfaces must use a registrable HTTPS origin" });
  }
}

function warnDeprecatedGatewayConfig(value: unknown): void {
  if (deprecatedGatewayConfigWarningEmitted || !value || typeof value !== "object") return;
  const gateway = "gateway" in value ? (value as { gateway?: unknown }).gateway : undefined;
  if (!gateway || typeof gateway !== "object") return;
  const fields = DEPRECATED_GATEWAY_CONFIG_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(gateway, field));
  if (fields.length === 0) return;
  deprecatedGatewayConfigWarningEmitted = true;
  console.warn(JSON.stringify({
    event: "config.deprecated_fields",
    scope: "gateway",
    fields
  }));
}

function warnDeprecatedOidcCanonicalIpConfig(value: unknown): void {
  if (deprecatedOidcCanonicalIpWarningEmitted || !value || typeof value !== "object") return;
  const oidc = "oidc" in value ? (value as { oidc?: unknown }).oidc : undefined;
  if (!oidc || typeof oidc !== "object" || !Object.prototype.hasOwnProperty.call(oidc, "canonicalClientIpHeader")) return;
  deprecatedOidcCanonicalIpWarningEmitted = true;
  console.warn(JSON.stringify({
    event: "config.deprecated_fields",
    scope: "oidc",
    fields: ["canonicalClientIpHeader"],
    replacement: "security.abuseRateLimit.canonicalClientIpHeader"
  }));
}

export function redactSecrets<T>(value: T, redactKeys: string[] = []): T {
  const keys = new Set(["authorization", "apiKey", "password", "jwtSecret", "bootstrapToken", "clientSecret", "privateKey", "code", "accessToken", "refreshToken", "codeVerifier", ...redactKeys]);
  function visit(input: unknown, path = ""): unknown {
    if (Array.isArray(input)) return input.map((item, index) => visit(item, `${path}.${index}`));
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => {
        const dotted = path ? `${path}.${key}` : key;
        return [key, keys.has(key) || keys.has(dotted) ? "[REDACTED]" : visit(entry, dotted)];
      })
    );
  }
  return visit(value) as T;
}
