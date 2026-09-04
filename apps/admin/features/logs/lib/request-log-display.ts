export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

export interface RequestLogIngressPlugin {
  id: string;
  abbreviation: string;
  version: number;
  outcome: "success" | "unmatched" | "failed";
}

export interface RequestLogPipelinePlugin {
  id: string;
  abbreviation: string;
  behaviorVersion: number;
  hook: string;
  instanceRevision: string;
  outcome: "applied" | "noop" | "denied" | "failed" | "fallback";
}

export interface RequestLogRow {
  id: string;
  startedAt: string;
  time: string;
  duration: string;
  status: string;
  statusTone: Tone;
  errorCode: string;
  ingressPlugins: RequestLogIngressPlugin[];
  pipelinePlugins: RequestLogPipelinePlugin[];
  requestPath: string;
  ingressHostname: string;
  ingressRouteId: string;
  provider: string;
  model: string;
  apiKey: string;
  user: string;
  team: string;
}

export function formatIngressPlugins(value: string): RequestLogIngressPlugin[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || !Number.isInteger(record.version)) return [];
      const outcome = record.success === true ? "success" : record.success === false ? "failed" : "unmatched";
      return [{ id: record.id, abbreviation: abbreviatePluginId(record.id), version: record.version as number, outcome }];
    });
  } catch {
    return [];
  }
}

export function formatIngressPluginDetails(plugins: readonly RequestLogIngressPlugin[]): string {
  return plugins.length > 0
    ? plugins.map((plugin) => `${plugin.id}@v${plugin.version} (${plugin.outcome})`).join(", ")
    : "None";
}

export function formatPipelinePlugins(value: string): RequestLogPipelinePlugin[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.invocations)) return [];
    return snapshot.invocations.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.pluginId !== "string" || !Number.isInteger(record.behaviorVersion)
        || typeof record.hook !== "string" || typeof record.instanceRevision !== "string"
        || !["applied", "noop", "denied", "failed", "fallback"].includes(String(record.outcome))) return [];
      return [{
        id: record.pluginId,
        abbreviation: abbreviatePluginId(record.pluginId),
        behaviorVersion: record.behaviorVersion as number,
        hook: record.hook,
        instanceRevision: record.instanceRevision,
        outcome: record.outcome as RequestLogPipelinePlugin["outcome"]
      }];
    });
  } catch {
    return [];
  }
}

export function formatPipelinePluginDetails(plugins: readonly RequestLogPipelinePlugin[]): string {
  return plugins.length > 0
    ? plugins.map((plugin) => `${plugin.id}@b${plugin.behaviorVersion} ${plugin.hook} (${plugin.outcome})`).join(", ")
    : "None";
}

function abbreviatePluginId(id: string): string {
  const segments = id.split("-").filter(Boolean);
  if (segments.length > 1) return segments.map((segment) => segment[0]!.toUpperCase()).join("");
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
