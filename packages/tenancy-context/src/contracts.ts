import type { AuditActor, AuditMetadataValue, AuditResult, AuditSource, IdentityTenancyAuditAction } from "@frely/audit";
import type { ScopeRef } from "@frely/core";
import type { EmailAddr } from "@frely/identity";

export interface TeamSnapshot { id: string; ownerId: string; name: string; status: string; teamOwnerCanManageMemberApiKeyLimit: number; teamOwnerCanManageMemberCredit: number; teamOwnerCanCreateCustomProvider: number; teamOwnerCanCreateAccessPoint: number; inviteEmailDomainPattern: string | null; createdAt: string; updatedAt: string; }
export interface TeamMembershipSnapshot { id: string; teamId: string; userId: string; rolesJson: string; byInviteLink: string | null; createdAt: string; updatedAt: string; }
export interface TeamInviteLinkSnapshot { id: string; teamId: string; createdByUserId: string; maxUses: number | null; usedCount: number | null; activeLimitExempt: number; status: string; createdAt: string; updatedAt: string; }
export interface ResourcePermissionSnapshot { id: string; resourceType: string; resourceId: string; action: string; subjectType: string; subjectRef: string; subjectRole: string | null; status: string; createdAt: string; updatedAt: string; }
export interface TeamInviteLinkCreateResult { inviteLink: TeamInviteLinkSnapshot; outcome: "created" | "already_active"; }
export interface TenancyPermissionDecision { allowed: boolean; reason: "platform_owner" | "team_owner" | "permission_grant" | "not_allowed"; }
export interface TeamDeletionSnapshot { id: string; teamId: string; requestedAt: string; requestedByUserId: string; purgeNotBefore: string; archiveStatus: string; cancelledAt: string | null; purgedAt: string | null; }
export interface IdentityTenancyAuditInput { actor: AuditActor; action: IdentityTenancyAuditAction; resource: { resourceType: "user" | "api_key" | "passkey" | "team" | "team_membership" | "team_invite_link"; resourceId: string }; result: AuditResult; source: AuditSource; metadata?: Readonly<Record<string, AuditMetadataValue>>; requestId?: string | null | undefined; }

export interface TenancyContextQueries {
  getTeam(teamId: string): Promise<TeamSnapshot | undefined>;
  listTeams(): Promise<TeamSnapshot[]>;
  isTeamAvailable(teamId: string): Promise<boolean>;
  getMembership(teamId: string, userId: string): Promise<TeamMembershipSnapshot | undefined>;
  listMembershipsForUser(userId: string): Promise<TeamMembershipSnapshot[]>;
  listAvailableMembershipsForUser(userId: string): Promise<TeamMembershipSnapshot[]>;
  listEffectiveSubscriptionScopesForUser(userId: string): Promise<ScopeRef[]>;
  countCurrentOwnedTeams(userId: string): Promise<number>;
  teamRolesForUser(userId: string): Promise<string[]>;
  getInviteLink(inviteLinkId: string): Promise<TeamInviteLinkSnapshot | undefined>;
  listInviteLinks(teamId: string, createdByUserId?: string): Promise<TeamInviteLinkSnapshot[]>;
  getActiveInviteLinkForCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLinkSnapshot | undefined>;
  listEnabledInviteLinksByCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLinkSnapshot[]>;
  listEnabledNonOwnerInviteLinks(teamId: string, ownerId: string): Promise<TeamInviteLinkSnapshot[]>;
  listResourcePermissions(resourceType: string, resourceId: string): Promise<ResourcePermissionSnapshot[]>;
  isTeamMemberInvitesEnabled(teamId: string): Promise<boolean>;
  decidePermission(input: { userId: string; resourceType: string; resourceId: string; action: string; platformOwner: boolean }): Promise<TenancyPermissionDecision>;
  inviteEmailAllowed(email: EmailAddr, pattern: string | null): boolean;
}

export interface TenancyContextCommands {
  createTeam(input: { id?: string; ownerUserId: string; name: string; status?: string; createdAt?: string }): Promise<TeamSnapshot>;
  createTeamWithOwnerMembership(input: { id?: string; ownerUserId: string; name: string; status?: string }): Promise<{ team: TeamSnapshot; membership: TeamMembershipSnapshot }>;
  ensureBootstrapTeam(input: { id: "team_default"; ownerUserId: string; name: string }): Promise<{ team: TeamSnapshot; created: boolean; changed: boolean }>;
  grantMembership(teamId: string, userId: string, roles?: readonly string[], byInviteLink?: string | null): Promise<TeamMembershipSnapshot>;
  ensureFallbackMembership(userId: string, bootstrapOwnerUserId: string | undefined): Promise<{ membership: TeamMembershipSnapshot; created: boolean }>;
  removeMembership(teamId: string, userId: string): Promise<TeamMembershipSnapshot | undefined>;
  changeMembershipRoles(teamId: string, userId: string, roles: readonly string[]): Promise<TeamMembershipSnapshot | undefined>;
  createInviteLink(input: { teamId: string; createdByUserId: string; maxUses: number | null; activeLimitExempt?: boolean }): Promise<TeamInviteLinkSnapshot>;
  getOrCreateActiveInviteLink(teamId: string, createdByUserId: string, maxUses: number | null): Promise<TeamInviteLinkCreateResult>;
  disableInviteLink(inviteLinkId: string): Promise<TeamInviteLinkSnapshot | undefined>;
  consumeInviteLink(inviteLinkId: string): Promise<TeamInviteLinkSnapshot>;
  updateTeamManagementSettings(teamId: string, input: { name?: string; teamOwnerCanManageMemberApiKeyLimit?: number; teamOwnerCanManageMemberCredit?: number; teamOwnerCanCreateAccessPoint?: number }): Promise<TeamSnapshot>;
  updateInviteEmailDomain(teamId: string, pattern: string | null): Promise<TeamSnapshot>;
  upsertResourcePermission(input: { resourceType: string; resourceId: string; action: string; subjectType: string; subjectRef: string; subjectRole?: string | null; status?: string }): Promise<ResourcePermissionSnapshot>;
  requestTeamDeletion(teamId: string, requestedByUserId: string, requestedAt?: string): Promise<TeamDeletionSnapshot>;
  cancelTeamDeletion(teamId: string, cancelledAt?: string): Promise<TeamDeletionSnapshot>;
  transferOwnership(input: { teamId: string; nextOwnerUserId: string; nextOwnerEnabled: boolean; actorUserId: string; appendAudit: (teamId: string, previousOwnerUserId: string, nextOwnerUserId: string) => Promise<void> }): Promise<TeamSnapshot>;
}

type AssertTenancyCapabilitiesDisjoint<Value extends never> = Value;
type _TenancyCapabilitiesDisjoint = AssertTenancyCapabilitiesDisjoint<Extract<keyof TenancyContextQueries, keyof TenancyContextCommands>>;
