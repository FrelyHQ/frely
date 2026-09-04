import type { UiQueryPort, UiSyncQueryPort } from "@frely/ui-application/contracts";
import type { TenancyQueries } from "@frely/tenancy/server";

export interface DashboardMetric {
  label: string;
  value: string;
  detail: string;
  href?: string;
  tone?: "good" | "warn" | "bad";
}

export interface DashboardProviderLatency {
  name: string;
  latency: string;
  value: number;
  tone: "good" | "warn" | "bad";
}

export interface DashboardAggregate {
  metrics: DashboardMetric[];
  requestVolume: number[];
  requestVolumeLabels: string[];
  requestVolumeStatus: "Operational" | "Degraded" | "Needs Review";
  requestVolumeTone: "good" | "warn" | "bad";
  providerLatency: DashboardProviderLatency[];
}

export function buildAdminDashboardAggregate(repo: UiSyncQueryPort, tenancy: Pick<UiSyncQueryPort, "listTeams">, now = new Date()): DashboardAggregate {
  const teams = tenancy.listTeams();
  const providers = repo.listProviders();
  const usage = repo.usageSummary();
  const budgets = repo.listBudgetPolicies();

  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentRequestFilter = { startedAtGte: windowStart.toISOString(), startedAtLte: now.toISOString() };
  const recentRequests = repo.listRecentRequestLogs(recentRequestFilter, repo.countRequestLogs(recentRequestFilter));
  const failedRequests = recentRequests.filter((request) => request.status === "failed");
  const providerIssues = providers.filter((provider) => !["active", "healthy", "enabled"].includes(provider.status.toLowerCase()));
  const totalBudget = budgets.filter((budget) => budget.metric === "amount" && budget.status === "enabled").reduce((sum, budget) => sum + budget.limitValue, 0);
  const budgetUsagePercent = totalBudget > 0 ? Math.min(100, (usage.calculatedCost / totalBudget) * 100) : 0;

  return {
    metrics: [
      {
        label: "Critical Alerts",
        value: String(failedRequests.length + providerIssues.length),
        detail: `${failedRequests.length} failed requests, ${providerIssues.length} provider issues`,
        href: failedRequests.length > 0 ? `/owner/request-logs?status=failed&timeWindow=24h&start=${encodeURIComponent(now.toISOString())}` : providerIssues.length > 0 ? "/owner/providers?status=issues" : `/owner/request-logs?timeWindow=24h&start=${encodeURIComponent(now.toISOString())}`,
        tone: failedRequests.length + providerIssues.length > 0 ? "bad" : "good"
      },
      {
        label: "Providers",
        value: String(providers.length),
        detail: `${providers.length - providerIssues.length}/${providers.length} healthy`,
        href: providerIssues.length > 0 ? "/owner/providers?status=issues" : "/owner/providers",
        tone: providerIssues.length === 0 ? "good" : providerIssues.length === providers.length ? "bad" : "warn"
      },
      {
        label: "Budget Usage",
        value: formatCurrency(usage.calculatedCost),
        detail: totalBudget > 0 ? `${formatPercent(budgetUsagePercent)} consumed` : "No amount caps",
        href: "/owner/plans-and-budgets/budget-policies",
        ...(budgetUsagePercent >= 90 ? { tone: "bad" as const } : budgetUsagePercent >= 70 ? { tone: "warn" as const } : {})
      },
      {
        label: "Total Teams",
        value: String(teams.length),
        detail: `${enabledCount(teams)} enabled`,
        href: "/owner/teams",
        ...(teams.length > 0 ? { tone: "good" as const } : {})
      }
    ],
    requestVolume: buildRequestVolume(recentRequests, windowStart, now),
    requestVolumeLabels: buildRequestVolumeLabels(windowStart, now),
    requestVolumeStatus: failedRequests.length === 0 ? "Operational" : failedRequests.length < recentRequests.length ? "Degraded" : "Needs Review",
    requestVolumeTone: failedRequests.length === 0 ? "good" : failedRequests.length < recentRequests.length ? "warn" : "bad",
    providerLatency: buildProviderLatency(repo, recentRequests)
  };
}

export async function buildAdminDashboardAggregateAsync(
  repo: Pick<UiQueryPort, "listProviders" | "usageSummary" | "listBudgetPolicies" | "countRequestLogs" | "listRecentRequestLogs">,
  tenancy: Pick<TenancyQueries, "listTeams">,
  now = new Date(),
): Promise<DashboardAggregate> {
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentRequestFilter = { startedAtGte: windowStart.toISOString(), startedAtLte: now.toISOString() };
  const [teams, providers, usage, budgets, recentRequestCount] = await Promise.all([
    tenancy.listTeams(),
    repo.listProviders(),
    repo.usageSummary(),
    repo.listBudgetPolicies(),
    repo.countRequestLogs(recentRequestFilter),
  ]);
  const recentRequests = await repo.listRecentRequestLogs(recentRequestFilter, recentRequestCount);
  const failedRequests = recentRequests.filter((request) => request.status === "failed");
  const providerIssues = providers.filter((provider) => !["active", "healthy", "enabled"].includes(provider.status.toLowerCase()));
  const totalBudget = budgets.filter((budget) => budget.metric === "amount" && budget.status === "enabled").reduce((sum, budget) => sum + budget.limitValue, 0);
  const budgetUsagePercent = totalBudget > 0 ? Math.min(100, (usage.calculatedCost / totalBudget) * 100) : 0;
  return {
    metrics: [
      {
        label: "Critical Alerts",
        value: String(failedRequests.length + providerIssues.length),
        detail: `${failedRequests.length} failed requests, ${providerIssues.length} provider issues`,
        href: failedRequests.length > 0 ? `/owner/request-logs?status=failed&timeWindow=24h&start=${encodeURIComponent(now.toISOString())}` : providerIssues.length > 0 ? "/owner/providers?status=issues" : `/owner/request-logs?timeWindow=24h&start=${encodeURIComponent(now.toISOString())}`,
        tone: failedRequests.length + providerIssues.length > 0 ? "bad" : "good",
      },
      {
        label: "Providers",
        value: String(providers.length),
        detail: `${providers.length - providerIssues.length}/${providers.length} healthy`,
        href: providerIssues.length > 0 ? "/owner/providers?status=issues" : "/owner/providers",
        tone: providerIssues.length === 0 ? "good" : providerIssues.length === providers.length ? "bad" : "warn",
      },
      {
        label: "Budget Usage",
        value: formatCurrency(usage.calculatedCost),
        detail: totalBudget > 0 ? `${formatPercent(budgetUsagePercent)} consumed` : "No amount caps",
        href: "/owner/plans-and-budgets/budget-policies",
        ...(budgetUsagePercent >= 90 ? { tone: "bad" as const } : budgetUsagePercent >= 70 ? { tone: "warn" as const } : {}),
      },
      {
        label: "Total Teams",
        value: String(teams.length),
        detail: `${enabledCount(teams)} enabled`,
        href: "/owner/teams",
        ...(teams.length > 0 ? { tone: "good" as const } : {}),
      },
    ],
    requestVolume: buildRequestVolume(recentRequests, windowStart, now),
    requestVolumeLabels: buildRequestVolumeLabels(windowStart, now),
    requestVolumeStatus: failedRequests.length === 0 ? "Operational" : failedRequests.length < recentRequests.length ? "Degraded" : "Needs Review",
    requestVolumeTone: failedRequests.length === 0 ? "good" : failedRequests.length < recentRequests.length ? "warn" : "bad",
    providerLatency: buildProviderLatencyRows(providers, recentRequests),
  };
}

function enabledCount(rows: Array<{ status: string }>) {
  return rows.filter((row) => ["active", "enabled", "healthy"].includes(row.status.toLowerCase())).length;
}

function buildRequestVolume(requests: Array<{ startedAt: string }>, windowStart: Date, now: Date) {
  const buckets = Array.from({ length: 12 }, () => 0);
  const bucketMs = (now.getTime() - windowStart.getTime()) / buckets.length;
  for (const request of requests) {
    const startedAt = Date.parse(request.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    const index = Math.min(buckets.length - 1, Math.max(0, Math.floor((startedAt - windowStart.getTime()) / bucketMs)));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  const max = Math.max(...buckets, 1);
  return buckets.map((count) => Math.max(count === 0 ? 4 : 8, Math.round((count / max) * 100)));
}

function buildRequestVolumeLabels(windowStart: Date, now: Date) {
  return [windowStart, addHours(windowStart, 6), addHours(windowStart, 12), addHours(windowStart, 18), now].map((date) =>
    new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
  );
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function buildProviderLatency(repo: UiSyncQueryPort, requests: Array<{ providerId: string | null; startedAt: string; endedAt: string | null }>): DashboardProviderLatency[] {
  const providers = repo.listProviders();
  return buildProviderLatencyRows(providers, requests);
}

function buildProviderLatencyRows(providers: Awaited<ReturnType<UiSyncQueryPort["listProviders"]>>, requests: Array<{ providerId: string | null; startedAt: string; endedAt: string | null }>): DashboardProviderLatency[] {
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  const grouped = new Map<string, number[]>();

  for (const request of requests) {
    if (!request.providerId || !request.endedAt) continue;
    const startedAt = Date.parse(request.startedAt);
    const endedAt = Date.parse(request.endedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) continue;
    grouped.set(request.providerId, [...(grouped.get(request.providerId) ?? []), endedAt - startedAt]);
  }

  const rows = [...grouped.entries()]
    .map(([providerId, durations]) => {
      const averageMs = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
      return providerLatencyRow(providerNames.get(providerId) ?? providerId, averageMs);
    })
    .sort((left, right) => right.value - left.value);

  if (rows.length > 0) return rows.slice(0, 4);

  return providers.slice(0, 4).map((provider) => ({
    name: provider.name,
    latency: "No requests",
    value: 0,
    tone: provider.status.toLowerCase() === "active" ? "good" : "warn"
  }));
}

function providerLatencyRow(name: string, averageMs: number): DashboardProviderLatency {
  const value = Math.min(100, Math.round((averageMs / 1200) * 100));
  return {
    name,
    latency: `${Math.round(averageMs)}ms`,
    value,
    tone: value > 80 ? "bad" : value > 40 ? "warn" : "good"
  };
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}
