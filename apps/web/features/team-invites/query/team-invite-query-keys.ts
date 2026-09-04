export const teamInviteKeys = {
  all: ["web", "team-invites"] as const,
  audience: (teamId: string, viewerUserId: string) => [...teamInviteKeys.all, teamId, viewerUserId] as const,
  detail: (teamId: string, viewerUserId: string, page: number, pageSize: number) => [...teamInviteKeys.audience(teamId, viewerUserId), page, pageSize] as const,
};
