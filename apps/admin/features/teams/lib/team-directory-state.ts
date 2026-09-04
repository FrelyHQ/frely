import type { TeamDeletionLifecycle, TeamDeleteBlocker, TeamDirectorySort, TeamDirectorySortDirection } from "@frely/ui-application/contracts";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import type { TeamRow } from "@frely/team-console-ui";

type Tone = "good" | "warn" | "bad";

export interface AdminTeamDirectoryRow extends Omit<TeamRow, "usage" | "planName" | "planState" | "planWindow" | "planEffectiveStart" | "planEffectiveEnd" | "budget" | "budgetState"> {
  statusTone: Tone;
  deleteBlockers: TeamDeleteBlocker[];
  deletionLifecycle: TeamDeletionLifecycle | null;
}

export interface AdminTeamsSearchState {
  query: string;
  page: number;
  pageSize: TablePageSize;
  sort: TeamDirectorySort;
  direction: TeamDirectorySortDirection;
}

export function adminTeamsHref(state: AdminTeamsSearchState, overrides: Partial<AdminTeamsSearchState> = {}) {
  const next = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (next.query) params.set("q", next.query);
  if (next.page > 1) params.set("page", String(next.page));
  if (next.pageSize !== 20) params.set("pageSize", String(next.pageSize));
  if (next.sort !== "createdAt") params.set("sort", next.sort);
  if (next.direction !== "asc") params.set("direction", next.direction);
  const query = params.toString();
  return `/owner/teams${query ? `?${query}` : ""}`;
}
