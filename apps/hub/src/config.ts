import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isPublicProviderAddress, RelayError } from "@frely/core";
import { z } from "zod";

const upstreamKindSchema = z.enum(["remote-openai", "local-openai", "local-claude", "local-apfel", "mock-openai"]);
const protocolSchema = z.enum(["openai", "claude"]);
const routeProtocolSchema = z.enum(["openai", "claude", "any"]);
const proxyModeSchema = z.enum(["none", "env", "explicit"]);

const proxyConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("env") }),
  z.object({ mode: z.literal("explicit"), urlEnv: z.string().min(1) })
]);

const configSchema = z.object({
  server: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().positive().default(43003),
    authTokenEnv: z.string().min(1).default("FRIDAY_HUB_API_TOKEN")
  }).default({}),
  proxy: proxyConfigSchema.default({ mode: "env" }),
  modelDiscovery: z.object({
    cacheTtlSeconds: z.number().int().positive().default(86400)
  }).default({}),
  security: z.object({
    localNetworkAllowlist: z.array(z.string().min(1)).default([])
  }).default({}),
  upstreams: z.array(z.discriminatedUnion("kind", [
    z.object({
      id: z.string().min(1),
      kind: z.literal("remote-openai"),
      baseUrl: z.string().url(),
      apiKeyEnv: z.string().min(1).optional(),
      proxy: z.union([z.literal("default"), proxyConfigSchema]).optional()
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal("local-openai"),
      baseUrl: z.string().url(),
      apiKeyEnv: z.string().min(1).optional(),
      proxy: z.union([z.literal("default"), proxyConfigSchema]).optional()
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal("local-claude"),
      baseUrl: z.string().url(),
      apiKeyEnv: z.string().min(1).optional(),
      proxy: z.union([z.literal("default"), proxyConfigSchema]).optional()
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal("local-apfel"),
      baseUrl: z.string().url().default("http://127.0.0.1:11434/v1"),
      apiKeyEnv: z.string().min(1).optional(),
      proxy: z.union([z.literal("default"), proxyConfigSchema]).optional()
    }),
    z.object({
      id: z.string().min(1),
      kind: z.literal("mock-openai"),
      models: z.array(z.string().min(1)).min(1).default(["mock-local-llm"]),
      responseText: z.string().default("ok")
    })
  ])).default([]),
  routes: z.array(z.object({
    sourceProtocol: routeProtocolSchema.default("any"),
    model: z.string().min(1),
    upstream: z.string().min(1),
    targetProtocol: protocolSchema.optional(),
    targetModel: z.string().min(1).optional(),
    priority: z.number().int().default(0),
    fallback: z.array(z.string().min(1)).optional()
  })).default([])
});

export type HubConfig = z.infer<typeof configSchema>;
export type HubUpstream = HubConfig["upstreams"][number];
export type HubRoute = HubConfig["routes"][number];
export type HubProxyConfig = z.infer<typeof proxyConfigSchema>;
export type HubProtocol = z.infer<typeof protocolSchema>;
export type HubUpstreamKind = z.infer<typeof upstreamKindSchema>;

export const developmentHubConfigPath = resolve("data/hub/friday-hub.config.json");
export const userHubConfigPath = resolve(homedir(), ".friday-hub/config.json");

export function loadHubConfig(pathOverride = process.env.FRIDAY_HUB_CONFIG): HubConfig {
  const path = selectConfigPath(pathOverride);
  if (!path) return configSchema.parse({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new RelayError("invalid_hub_config", `Unable to read friday-hub config: ${messageFromError(error)}`, 500);
  }
  assertNoInlineSecrets(parsed);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new RelayError("invalid_hub_config", "friday-hub config failed validation", 500);
  }
  assertUniqueIds(result.data.upstreams.map((upstream) => upstream.id), "upstream");
  assertRemoteUpstreamBaseUrls(result.data.upstreams);
  for (const route of result.data.routes) {
    const upstream = result.data.upstreams.find((candidate) => candidate.id === route.upstream);
    if (!upstream) {
      throw new RelayError("invalid_hub_config", `Route ${route.model} references unknown upstream ${route.upstream}`, 500);
    }
    const upstreamProtocol = defaultTargetProtocolForUpstream(upstream.kind);
    if (route.targetProtocol && route.targetProtocol !== upstreamProtocol) {
      throw new RelayError("invalid_hub_config", `Route ${route.model} targetProtocol ${route.targetProtocol} conflicts with upstream ${route.upstream} kind ${upstream.kind}`, 500);
    }
    if (!route.targetModel && !defaultTargetModelForUpstream(upstream.kind)) {
      throw new RelayError("invalid_hub_config", `Route ${route.model} must configure targetModel for upstream ${route.upstream}`, 500);
    }
    for (const fallback of route.fallback ?? []) {
      if (!result.data.upstreams.some((upstream) => upstream.id === fallback)) {
        throw new RelayError("invalid_hub_config", `Route ${route.model} references unknown fallback upstream ${fallback}`, 500);
      }
    }
  }
  return result.data;
}

export function selectConfigPath(pathOverride?: string): string | null {
  if (pathOverride) return resolve(pathOverride);
  if (existsSync(developmentHubConfigPath)) return developmentHubConfigPath;
  if (existsSync(userHubConfigPath)) return userHubConfigPath;
  return null;
}

export function defaultTargetProtocolForUpstream(kind: HubUpstreamKind): HubProtocol {
  return kind === "local-claude" ? "claude" : "openai";
}

export function defaultTargetModelForUpstream(kind: HubUpstreamKind): string | null {
  if (kind === "mock-openai") return "mock-local-llm";
  return kind === "local-apfel" ? "apple-foundationmodel" : null;
}

function assertUniqueIds(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new RelayError("invalid_hub_config", `Duplicate ${label} id: ${value}`, 500);
    seen.add(value);
  }
}

function assertRemoteUpstreamBaseUrls(upstreams: HubUpstream[]): void {
  for (const upstream of upstreams) {
    if (upstream.kind !== "remote-openai") continue;
    const url = new URL(upstream.baseUrl);
    if (url.protocol !== "https:") {
      throw new RelayError("invalid_hub_config", `Remote upstream ${upstream.id} must use HTTPS baseUrl`, 500);
    }
    if (url.username || url.password || url.hash) {
      throw new RelayError("invalid_hub_config", `Remote upstream ${upstream.id} baseUrl cannot contain credentials or a fragment`, 500);
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || (isIP(hostname) !== 0 && !isPublicProviderAddress(hostname))) {
      throw new RelayError("invalid_hub_config", `Remote upstream ${upstream.id} baseUrl must target a public host`, 500);
    }
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

const forbiddenInlineSecretKeys = new Set([
  "apikey",
  "api_key",
  "authorization",
  "bearertoken",
  "bearer_token",
  "password",
  "proxypassword",
  "proxy_password",
  "secret",
  "clientsecret",
  "client_secret",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token"
]);

function assertNoInlineSecrets(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenInlineSecretKeys.has(key.toLowerCase())) {
      throw new RelayError("invalid_hub_config", `friday-hub config must reference secrets through env fields, not ${path}.${key}`, 500);
    }
    assertNoInlineSecrets(child, `${path}.${key}`);
  }
}
