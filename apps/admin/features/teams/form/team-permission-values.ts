import type { ResourcePermissionRow } from "../api/team-api";

export const teamManagementPermissionActions = [
  "team.read",
  "team.member.read",
  "team.member.update",
  "team.usage.read",
  "team.billing.read",
  "team.credit.read",
  "team.provider.create",
  "team.access_point.create",
  "team.ap_price.append",
  "team.invite_link.create"
] as const;

export type TeamManagementPermissionAction = typeof teamManagementPermissionActions[number];

export function hasDirectUserPermission(permissions: ResourcePermissionRow[], userId: string, action: TeamManagementPermissionAction) {
  return permissions.some((permission) => permission.action === action
    && permission.subjectType === "user"
    && permission.subjectRef === userId
    && permission.status === "enabled");
}

export function toDirectUserPermissionInput(teamId: string, userId: string, action: TeamManagementPermissionAction, enabled: boolean) {
  return {
    resourceType: "team",
    resourceId: teamId,
    action,
    subjectType: "user",
    subjectRef: userId,
    subjectRole: null,
    status: enabled ? "enabled" : "disabled"
  } as const;
}
