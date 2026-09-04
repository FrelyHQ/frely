import { queryOptions } from "@tanstack/react-query";
import { fetchTeamInviteData } from "../api/team-invite-api";
import { teamInviteKeys } from "./team-invite-query-keys";
export function teamInviteQueryOptions(teamId: string, teamName: string, viewerUserId: string, page: number, pageSize: number) {
  return queryOptions({
    queryKey: teamInviteKeys.detail(teamId, viewerUserId, page, pageSize),
    queryFn: ({ signal }) => fetchTeamInviteData(teamId, teamName, viewerUserId, page, pageSize, signal),
    staleTime: 15_000,
    retry: false,
  });
}
