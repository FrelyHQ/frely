import type { TablePageSize } from "@frely/console-ui/pagination";

export interface UserTeamDirectoryRow {
  id: string;
  name: string;
  ownerId: string;
  role: string;
  status: "Active";
  members: string;
  usage: string;
  plan: string;
}

export interface UserTeamDirectoryView {
  query: string;
  rows: UserTeamDirectoryRow[];
  ownerTeams: number;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function userTeamDirectoryHref(state: { query: string; page: number; pageSize: TablePageSize }): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 20) params.set("pageSize", String(state.pageSize));
  const query = params.toString();
  return query ? `/user/team?${query}` : "/user/team";
}
