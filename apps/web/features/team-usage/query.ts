import type { TeamMemberUsageDirection, TeamMemberUsageSort } from "@frely/ui-application/contracts";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export interface TeamUsageUrlState {
  subscriptionId: string;
  query: string;
  sort: TeamMemberUsageSort;
  direction: TeamMemberUsageDirection;
  page: number;
  pageSize: TablePageSize;
}

export function teamUsageHref(teamId: string, state: TeamUsageUrlState): string {
  const params = new URLSearchParams();
  if (state.subscriptionId) params.set("subscriptionId", state.subscriptionId);
  if (state.query) params.set("q", state.query);
  if (state.sort !== "usage") params.set("sort", state.sort);
  if (state.direction !== "desc") params.set("direction", state.direction);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 20) params.set("pageSize", String(state.pageSize));
  const query = params.toString();
  return `/user/team/${encodeURIComponent(teamId)}/usage${query ? `?${query}` : ""}`;
}

export function parseTeamUsageUrlState(
  params: Record<string, string | string[] | undefined> | undefined,
): Omit<TeamUsageUrlState, "subscriptionId"> & { subscriptionId: string | null } {
  const subscriptionId = single(params?.subscriptionId)?.trim() || null;
  const query = (single(params?.q) ?? "").trim().slice(0, 100);
  const rawSort = single(params?.sort);
  const sort: TeamMemberUsageSort = rawSort === "tokens"
    || rawSort === "requests"
    || rawSort === "member"
    || rawSort === "lastUsed"
    ? rawSort
    : "usage";
  const direction = single(params?.direction) === "asc" ? "asc" : "desc";
  const rawPage = single(params?.page);
  const page = rawPage && /^[1-9]\d*$/.test(rawPage)
    ? Math.min(10_000, Number(rawPage))
    : 1;
  return { subscriptionId, query, sort, direction, page, pageSize: normalizeTablePageSize(params?.pageSize) };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
