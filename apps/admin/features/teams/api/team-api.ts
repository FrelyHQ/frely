import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type {
  CreateTeamInviteInput,
  DisableTeamInviteInput,
  TeamInviteActionResult,
  TeamInviteLinkViewModel,
  UpdateTeamInviteSettingsInput,
} from "@frely/team-console-ui/models";

export interface ResourcePermissionRow {
  id: string;
  action: string;
  subjectType: string;
  subjectRef: string;
  subjectRole: string | null;
  status: string;
}
export interface TeamMemberCandidate {
  id: string;
  email: string;
  status: string;
}
export interface TeamMemberCandidatePage {
  items: TeamMemberCandidate[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
}
export interface TeamProviderProductCandidate {
  id: string;
  code: string;
  version: number;
  displayName: string;
  grantDurationSeconds: number;
}

export interface TeamDeleteBlocker {
  code: string;
  count: number;
}

export function createTeam(name: string) {
  return mutateJson("/api/owner/teams", "POST", { name }, "Failed to create team");
}

export function updateTeam(teamId: string, input: object, fallback = "Team update failed") {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}`, "PATCH", input, fallback);
}

export async function fetchTeamProviderProductCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/authority-product-candidates?${params.toString()}`, signal ? { signal } : {});
  return readConsoleApiResponse<{ items: TeamProviderProductCandidate[]; page: number; pageSize: 20; total: number; totalPages: number }>(response, "Failed to load Team Provider products");
}

export async function grantTeamProviderEntitlement(teamId: string, productId: string, idempotencyKey: string) {
  const response = await fetch(`/api/owner/teams/${encodeURIComponent(teamId)}/provider-entitlements`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ productId })
  });
  return readConsoleApiResponse<{ id: string }>(response, "Grant Team Provider access failed");
}

export function cancelTeamProviderEntitlement(entitlementId: string, reasonCode: string) {
  return mutateJson(`/api/owner/team-provider-entitlements/${encodeURIComponent(entitlementId)}/cancel`, "POST", { reasonCode }, "Cancel Team Provider access failed");
}

export async function updateTeams(teamIds: string[], input: object) {
  await Promise.all(teamIds.map((teamId) => updateTeam(teamId, input, `Update ${teamId} failed`)));
}

export async function deleteTeam(teamId: string, fallback = "Team delete failed") {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}`, "DELETE", undefined, fallback);
}

export function cancelTeamDeletion(teamId: string) {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}/cancel-deletion`, "POST", {}, "Team recovery failed");
}

export function purgeTeam(teamId: string, confirmation: string) {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}/purge`, "POST", { confirmation }, "Team purge failed");
}

export async function createAdminTeamInvite(input: CreateTeamInviteInput): Promise<TeamInviteActionResult> {
  const body = await mutateJson<{ inviteLink?: unknown; outcome?: string }>(
    `/api/owner/teams/${encodeURIComponent(input.teamId)}/invite-links`,
    "POST",
    { maxUses: input.maxUses },
    "Failed to create invitation link",
  );
  return { kind: "create-link", inviteLink: parseTeamInviteLink(body.inviteLink), ...(body.outcome ? { outcome: body.outcome } : {}) };
}

export async function disableAdminTeamInvite(input: DisableTeamInviteInput): Promise<TeamInviteActionResult> {
  await mutateJson(
    `/api/owner/teams/${encodeURIComponent(input.teamId)}/invite-links/${encodeURIComponent(input.inviteLinkId)}/disable`,
    "POST",
    undefined,
    "Failed to disable invitation link",
  );
  return { kind: "disable-link" };
}

export async function updateAdminTeamInviteSettings(input: UpdateTeamInviteSettingsInput): Promise<TeamInviteActionResult> {
  const body = await mutateJson<{ disabledMemberLinkCount?: number }>(
    `/api/owner/teams/${encodeURIComponent(input.teamId)}/invite-settings`,
    "PATCH",
    {
      ...(input.memberInvitesEnabled === undefined ? {} : { memberInvitesEnabled: input.memberInvitesEnabled }),
      ...(input.inviteEmailDomainPattern === undefined ? {} : { inviteEmailDomainPattern: input.inviteEmailDomainPattern }),
    },
    "Failed to update invitation settings",
  );
  if (input.memberInvitesEnabled !== undefined) {
    return {
      kind: "member-invites",
      enabled: input.memberInvitesEnabled,
      ...(typeof body.disabledMemberLinkCount === "number" ? { disabledMemberLinkCount: body.disabledMemberLinkCount } : {}),
    };
  }
  return { kind: "domain-pattern", pattern: input.inviteEmailDomainPattern ?? null };
}

export function testInviteEmailDomainRule(teamId: string, email: string, inviteEmailDomainPattern: string | null) {
  return mutateJson<{ allowed: boolean; domain: string }>(`/api/owner/teams/${encodeURIComponent(teamId)}/invite-settings/test`, "POST", { email, inviteEmailDomainPattern }, "Test invitation email domain rule failed");
}

export function addTeamMember(teamId: string, userId: string) {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}/members`, "POST", { userId }, "Add member failed");
}

export async function fetchTeamMemberCandidates(teamId: string, query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const response = await fetch(`/api/owner/team-member-candidates/${encodeURIComponent(teamId)}?${params.toString()}`, signal ? { signal } : {});
  return readConsoleApiResponse<TeamMemberCandidatePage>(response, "Failed to load Team member candidates");
}

export function changeTeamOwner(teamId: string, ownerId: string) {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}/owner`, "PATCH", { ownerId }, "Change owner failed");
}

export function removeTeamMember(teamId: string, userId: string) {
  return mutateJson(`/api/owner/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, "DELETE", undefined, "Remove member failed");
}

export function updateTeamMemberRoles(teamId: string, userId: string, roles: string[]) {
  return mutateJson<{ rolesJson?: string }>(`/api/owner/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/roles`, "PATCH", { roles }, "Update member roles failed");
}

export function updateTeamPermission(teamId: string, input: object) {
  return mutateJson<ResourcePermissionRow>(`/api/owner/teams/${encodeURIComponent(teamId)}/permissions`, "PATCH", input, "Update permission failed");
}

export function addTeamPlan(input: object) {
  return mutateJson("/api/owner/plans", "POST", input, "Add team plan failed");
}

async function mutateJson<T = unknown>(url: string, method: "POST" | "PATCH" | "DELETE", input: object | undefined, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(input === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
  });
  return readConsoleApiResponse<T>(response, fallbackMessage);
}

function parseTeamInviteLink(value: unknown): TeamInviteLinkViewModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The server returned an invalid invitation link");
  const link = value as Record<string, unknown>;
  if (typeof link.id !== "string"
    || typeof link.teamId !== "string"
    || (link.createdByUserId !== undefined && typeof link.createdByUserId !== "string")
    || (link.creatorEmail !== undefined && link.creatorEmail !== null && typeof link.creatorEmail !== "string")
    || (link.maxUses !== null && !Number.isInteger(link.maxUses))
    || (link.usedCount !== null && !Number.isInteger(link.usedCount))
    || typeof link.status !== "string"
    || typeof link.createdAt !== "string"
    || typeof link.updatedAt !== "string") {
    throw new Error("The server returned an invalid invitation link");
  }
  return {
    id: link.id,
    teamId: link.teamId,
    ...(typeof link.createdByUserId === "string" ? { createdByUserId: link.createdByUserId } : {}),
    ...(link.creatorEmail === undefined ? {} : { creatorEmail: link.creatorEmail as string | null }),
    maxUses: link.maxUses as number | null,
    usedCount: link.usedCount as number | null,
    status: link.status,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}
