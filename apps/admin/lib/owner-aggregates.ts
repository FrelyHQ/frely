import type { UiSyncQueryPort } from "@frely/ui-application/contracts";
import { formatUtcDateTime as formatDateTime } from "@frely/ui/lib/date-time";

type Tone = "good" | "warn" | "bad" | "neutral" | "info";

export interface AdminMetric {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warn" | "bad";
}

export interface ProviderHealthRow {
  id: string;
  name: string;
  status: string;
  statusTone: Tone;
  latency: string;
  pressure: number;
  pressureTone: "good" | "warn" | "bad";
  connection: string;
  uptime: string;
}

export interface ProviderAggregate {
  metrics: AdminMetric[];
  rows: ProviderHealthRow[];
}

export function buildProviderAggregate(repo: UiSyncQueryPort, now = new Date()): ProviderAggregate {
  const providers = repo.listProviders();
  const recentStart = now.getTime() - 24 * 60 * 60 * 1000;
  const recentRequestFilter = { startedAtGte: new Date(recentStart).toISOString(), startedAtLte: now.toISOString() };
  const recentRequests = repo.listRecentRequestLogs(recentRequestFilter, repo.countRequestLogs(recentRequestFilter));
  const rows = providers.map((provider) => {
    const providerRequests = recentRequests.filter((request) => request.providerId === provider.id);
    const completed = providerRequests.filter((request) => request.endedAt);
    const failed = providerRequests.filter((request) => request.status === "failed" || request.errorCode);
    const averageMs = averageLatencyMs(completed);
    const pressure = providerRequests.length > 0 ? Math.min(100, Math.round((providerRequests.length / Math.max(recentRequests.length, 1)) * 100)) : 0;
    const successRate = providerRequests.length > 0 ? ((providerRequests.length - failed.length) / providerRequests.length) * 100 : null;

    return {
      id: provider.id,
      name: provider.name,
      status: displayStatus(provider.status),
      statusTone: statusTone(provider.status),
      latency: averageMs === null ? "No requests" : `${Math.round(averageMs)}ms`,
      pressure,
      pressureTone: pressure > 80 ? "bad" : pressure > 40 ? "warn" : "good",
      connection: "CLIProxyAPI",
      uptime: successRate === null ? "No requests" : formatPercent(successRate)
    } satisfies ProviderHealthRow;
  });
  const healthyCount = rows.filter((row) => row.statusTone === "good").length;
  const criticalCount = rows.filter((row) => row.statusTone === "bad").length;
  const failoverEvents = recentRequests.filter((request) => request.status === "failed" || request.errorCode).length;
  const latencies = rows
    .map((row) => Number(row.latency.replace("ms", "")))
    .filter(Number.isFinite);
  const averageLatency = latencies.length > 0 ? `${Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)}ms` : "No requests";

  return {
    metrics: [
      {
        label: "Configured Providers",
        value: String(providers.length),
        detail: `${healthyCount} healthy`,
        ...(providers.length === 0 ? {} : { tone: criticalCount > 0 ? "bad" as const : "good" as const })
      },
      {
        label: "Avg. Latency",
        value: averageLatency,
        detail: "last 24h",
        ...(latencies.length > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Failover Events",
        value: String(failoverEvents),
        detail: "last 24h",
        tone: failoverEvents > 0 ? "warn" : "good"
      },
      {
        label: "Critical Providers",
        value: String(criticalCount),
        detail: criticalCount > 0 ? "Needs review" : "None",
        tone: criticalCount > 0 ? "bad" : "good"
      }
    ],
    rows
  };
}

function averageLatencyMs(requests: Array<{ startedAt: string; endedAt: string | null }>) {
  const durations = requests.flatMap((request) => {
    if (!request.endedAt) return [];
    const startedAt = Date.parse(request.startedAt);
    const endedAt = Date.parse(request.endedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return [];
    return [endedAt - startedAt];
  });
  if (durations.length === 0) return null;
  return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
}

function displayStatus(status: string) {
  if (isEnabled(status)) return "Healthy";
  if (["degraded", "warning"].includes(status.toLowerCase())) return "Degraded";
  if (["critical", "failed", "disabled"].includes(status.toLowerCase())) return "Critical";
  return titleCase(status);
}

function statusTone(status: string): Tone {
  const normalized = status.toLowerCase();
  if (isEnabled(normalized)) return "good";
  if (["degraded", "warning"].includes(normalized)) return "warn";
  if (["critical", "failed", "disabled"].includes(normalized)) return "bad";
  return "neutral";
}

function isEnabled(status: string) {
  return ["active", "enabled", "healthy"].includes(status.toLowerCase());
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}
