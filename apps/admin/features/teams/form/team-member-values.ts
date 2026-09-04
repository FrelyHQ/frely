import type { AdminTeamUserOption } from "../components/team-member-management";

export type TeamMembershipRole = "viewer" | "billing" | "manager";

export function filterTeamMemberCandidates(users: AdminTeamUserOption[], memberIds: ReadonlySet<string>, query: string) {
  const normalized = query.trim().toLowerCase();
  return users.filter((user) => !memberIds.has(user.id) && user.status === "enabled").filter((user) => !normalized || user.email.toLowerCase().includes(normalized) || user.id.toLowerCase().includes(normalized)).slice(0, 25);
}

export function toggleTeamMembershipRole(roles: string[], role: TeamMembershipRole, enabled: boolean) {
  return enabled ? Array.from(new Set([...roles, role])) : roles.filter((candidate) => candidate !== role);
}
