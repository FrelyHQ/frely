import { createHash } from "node:crypto";
import { createId, nowIso, RelayError, type ScopeRef } from "@frely/core";
import type { AuditActor, AuditMetadataValue, AuditResult, AuditSource, IdentityTenancyAuditAction } from "@frely/audit";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import type { EmailAddr } from "@frely/identity";
import type {
  IdentityTenancyAuditInput,
  ResourcePermissionSnapshot,
  TeamInviteLinkCreateResult,
  TeamInviteLinkSnapshot,
  TeamMembershipSnapshot,
  TeamSnapshot,
  TenancyContextCommands,
  TenancyContextQueries,
  TenancyPermissionDecision,
} from "./contracts.js";
export type * from "./contracts.js";

type PrismaTenancyClient = Prisma.TransactionClient;
type RootTenancyClient = PrismaTransactionOwner & { prisma: PrismaTenancyClient };

abstract class TenancyInfrastructure {
  constructor(protected readonly root: RootTenancyClient, protected readonly transaction?: PrismaTenancyClient) {}

  protected client(): PrismaTenancyClient {
    return this.transaction ?? this.root.prisma;
  }
}

/** Tenancy-owned named Queries over Team, membership, invitation, and permission facts. */
export class TenancyQueries extends TenancyInfrastructure implements TenancyContextQueries {
  constructor(root: RootTenancyClient, transaction?: PrismaTenancyClient) {
    super(root, transaction);
  }

  async getTeam(teamId: string): Promise<TeamSnapshot | undefined> {
    const row = await this.client().teams.findUnique({ where: { id: teamId } });
    return row ? teamSnapshot(row) : undefined;
  }

  async listTeams(): Promise<TeamSnapshot[]> {
    return (await this.client().teams.findMany({ orderBy: [{ created_at: "asc" }, { id: "asc" }] })).map(teamSnapshot);
  }

  async isTeamAvailable(teamId: string): Promise<boolean> {
    const team = await this.client().teams.findUnique({ where: { id: teamId }, select: { status: true } });
    if (!team || team.status !== "enabled") return false;
    return (await this.client().team_deletion_lifecycles.count({ where: { team_id: teamId, cancelled_at: null, purged_at: null } })) === 0;
  }

  async getMembership(teamId: string, userId: string): Promise<TeamMembershipSnapshot | undefined> {
    const row = await this.client().team_memberships.findUnique({ where: { team_id_user_id: { team_id: teamId, user_id: userId } } });
    return row ? membershipSnapshot(row) : undefined;
  }

  async listMembershipsForUser(userId: string): Promise<TeamMembershipSnapshot[]> {
    return (await this.client().team_memberships.findMany({ where: { user_id: userId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] })).map(membershipSnapshot);
  }

  async listAvailableMembershipsForUser(userId: string): Promise<TeamMembershipSnapshot[]> {
    const rows = await this.client().team_memberships.findMany({
      where: { user_id: userId, teams: { is: { status: "enabled" } } },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
    const activeDeletionTeamIds = await this.activeDeletionTeamIds(rows.map((row) => row.team_id));
    return rows.filter((row) => !activeDeletionTeamIds.has(row.team_id)).map(membershipSnapshot);
  }

  async listEffectiveSubscriptionScopesForUser(userId: string): Promise<ScopeRef[]> {
    const memberships = await this.listAvailableMembershipsForUser(userId);
    return ["global:", ...memberships.map((membership) => `team:${membership.teamId}` as const), `user:${userId}` as const];
  }

  async countCurrentOwnedTeams(userId: string): Promise<number> {
    const teams = await this.client().teams.findMany({ where: { owner_id: userId, status: "enabled" }, select: { id: true } });
    const activeDeletionTeamIds = await this.activeDeletionTeamIds(teams.map((team) => team.id));
    return teams.filter((team) => !activeDeletionTeamIds.has(team.id)).length;
  }

  async classifyIdentityMigrationUser(userId: string): Promise<{ ownedTenantCount: number; unsafeReferenceCount: number; transferStateFingerprint: string }> {
    const [ownedTenantCount, directPermissionCount, memberships] = await Promise.all([
      this.client().teams.count({ where: { owner_id: userId } }),
      this.client().resource_permissions.count({ where: { OR: [
        { subject_type: "user", subject_ref: userId },
        { resource_type: "user", resource_id: userId },
      ] } }),
      this.client().team_memberships.findMany({
        where: { user_id: userId },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        select: { id: true, team_id: true, roles_json: true, by_invite_link: true, created_at: true, updated_at: true },
      }),
    ]);
    const memberPermissionCount = memberships.length === 0 ? 0 : await this.client().resource_permissions.count({
      where: { subject_type: "member", subject_ref: { in: memberships.map((membership) => membership.id) } },
    });
    const transferStateFingerprint = createHash("sha256").update(JSON.stringify(memberships)).digest("hex");
    return Object.freeze({
      ownedTenantCount,
      unsafeReferenceCount: directPermissionCount + memberPermissionCount,
      transferStateFingerprint,
    });
  }

  async teamRolesForUser(userId: string): Promise<string[]> {
    const teams = await this.client().teams.findMany({
      where: { owner_id: userId, status: "enabled" },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const activeDeletionTeamIds = await this.activeDeletionTeamIds(teams.map((team) => team.id));
    return teams.filter((team) => !activeDeletionTeamIds.has(team.id)).map((team) => `owner:${team.id}`);
  }

  private async activeDeletionTeamIds(teamIds: readonly string[]): Promise<Set<string>> {
    if (teamIds.length === 0) return new Set();
    const rows = await this.client().team_deletion_lifecycles.findMany({
      where: { team_id: { in: [...teamIds] }, cancelled_at: null, purged_at: null },
      select: { team_id: true },
    });
    return new Set(rows.map((row) => row.team_id));
  }

  async getInviteLink(inviteLinkId: string): Promise<TeamInviteLinkSnapshot | undefined> {
    const row = await this.client().team_invite_links.findUnique({ where: { id: inviteLinkId } });
    return row ? inviteSnapshot(row) : undefined;
  }

  async listInviteLinks(teamId: string, createdByUserId?: string): Promise<TeamInviteLinkSnapshot[]> {
    return (await this.client().team_invite_links.findMany({
      where: { team_id: teamId, ...(createdByUserId === undefined ? {} : { created_by_user_id: createdByUserId }) },
      orderBy: createdByUserId === undefined ? [{ created_at: "asc" }, { id: "asc" }] : [{ created_at: "desc" }, { id: "desc" }],
    })).map(inviteSnapshot);
  }

  async getActiveInviteLinkForCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLinkSnapshot | undefined> {
    const row = await this.client().team_invite_links.findFirst({ where: { team_id: teamId, created_by_user_id: createdByUserId, status: "enabled" }, orderBy: [{ created_at: "desc" }, { id: "desc" }] });
    return row ? inviteSnapshot(row) : undefined;
  }

  async listEnabledInviteLinksByCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLinkSnapshot[]> {
    return (await this.listInviteLinks(teamId, createdByUserId)).filter((link) => link.status === "enabled");
  }

  async listEnabledNonOwnerInviteLinks(teamId: string, ownerId: string): Promise<TeamInviteLinkSnapshot[]> {
    return (await this.client().team_invite_links.findMany({ where: { team_id: teamId, status: "enabled", created_by_user_id: { not: ownerId } }, orderBy: [{ created_at: "asc" }, { id: "asc" }] })).map(inviteSnapshot);
  }

  async listResourcePermissions(resourceType: string, resourceId: string): Promise<ResourcePermissionSnapshot[]> {
    return (await this.client().resource_permissions.findMany({ where: { resource_type: resourceType, resource_id: resourceId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] })).map(permissionSnapshot);
  }

  async isTeamMemberInvitesEnabled(teamId: string): Promise<boolean> {
    return Boolean(await this.client().resource_permissions.findFirst({ where: { resource_type: "team", resource_id: teamId, action: "team.invite_link.create", subject_type: "team", subject_ref: teamId, subject_role: null, status: "enabled" }, select: { id: true } }));
  }

  async decidePermission(input: { userId: string; resourceType: string; resourceId: string; action: string; platformOwner: boolean }): Promise<TenancyPermissionDecision> {
    if (input.platformOwner) return { allowed: true, reason: "platform_owner" };
    const team = input.resourceType === "team" ? await this.getTeam(input.resourceId) : undefined;
    if (team?.ownerId === input.userId && await this.isTeamAvailable(team.id)) return { allowed: true, reason: "team_owner" };
    const memberships = await this.listAvailableMembershipsForUser(input.userId);
    const subjects = new Set<string>([`user:${input.userId}:`]);
    for (const membership of memberships) {
      subjects.add(`team:${membership.teamId}:`);
      subjects.add(`member:${membership.id}:`);
      for (const role of membershipRoles(membership.rolesJson)) subjects.add(`team_role:${membership.teamId}:${role}`);
    }
    const permissions = await this.listResourcePermissions(input.resourceType, input.resourceId);
    const granted = permissions.some((permission) => permission.status === "enabled" && permission.action === input.action && subjects.has(`${permission.subjectType}:${permission.subjectRef}:${permission.subjectRole ?? ""}`));
    return { allowed: granted, reason: granted ? "permission_grant" : "not_allowed" };
  }

  inviteEmailAllowed(email: EmailAddr, pattern: string | null): boolean {
    if (pattern === null) return true;
    const domain = pattern.startsWith("^") && pattern.endsWith("$") ? pattern.slice(1, -1).replaceAll("\\.", ".") : pattern;
    return email.domain === domain.toLowerCase();
  }
}

/** Tenancy-owned named Commands. */
export class TenancyCommands extends TenancyInfrastructure implements TenancyContextCommands {
  private readonly queries: TenancyQueries;

  constructor(root: RootTenancyClient, transaction?: PrismaTenancyClient) {
    super(root, transaction);
    this.queries = new TenancyQueries(root, transaction);
  }

  private run<T>(callback: (commands: TenancyCommands) => Promise<T>, maxAttempts = 3): Promise<T> {
    if (this.transaction) return callback(this);
    return this.root.withPrismaTransaction(
      (transaction) => callback(new TenancyCommands(this.root, transaction)),
      maxAttempts,
    );
  }

  async createTeam(input: { id?: string; ownerUserId: string; name: string; status?: string; createdAt?: string }): Promise<TeamSnapshot> {
    return this.run(async (commands) => {
      const now = nowIso();
      const team = await commands.client().teams.create({ data: {
        id: input.id ?? createId("team"), owner_id: input.ownerUserId, name: input.name, status: input.status ?? "enabled",
        team_owner_can_manage_member_api_key_limit: 0, team_owner_can_manage_member_credit: 0,
        team_owner_can_create_custom_provider: 0, team_owner_can_create_access_point: 0,
        invite_email_domain_pattern: null, created_at: input.createdAt ?? now, updated_at: now,
      } });
      await commands.seedDefaultPermissions(team.id);
      return teamSnapshot(team);
    });
  }

  async createTeamWithOwnerMembership(input: { id?: string; ownerUserId: string; name: string; status?: string }): Promise<{ team: TeamSnapshot; membership: TeamMembershipSnapshot }> {
    return this.run(async (commands) => {
      const team = await commands.createTeam(input);
      const membership = await commands.grantMembership(team.id, input.ownerUserId);
      return { team, membership };
    });
  }

  /** System-bootstrap-only idempotent Team ownership repair. */
  async ensureBootstrapTeam(input: { id: "team_default"; ownerUserId: string; name: string }): Promise<{ team: TeamSnapshot; created: boolean; changed: boolean }> {
    return this.run(async (commands) => {
      const existing = await commands.queries.getTeam(input.id);
      if (!existing) return { team: await commands.createTeam({ id: input.id, ownerUserId: input.ownerUserId, name: input.name, status: "enabled" }), created: true, changed: true };
      const changed = existing.ownerId !== input.ownerUserId || existing.name !== input.name || existing.status !== "enabled";
      if (!changed) return { team: existing, created: false, changed: false };
      const row = await commands.client().teams.update({ where: { id: input.id }, data: { owner_id: input.ownerUserId, name: input.name, status: "enabled", updated_at: nowIso() } });
      return { team: teamSnapshot(row), created: false, changed: true };
    });
  }

  async grantMembership(teamId: string, userId: string, roles: readonly string[] = ["viewer"], byInviteLink: string | null = null): Promise<TeamMembershipSnapshot> {
    return this.run(async (commands) => {
      await commands.lockTeam(teamId);
      const existing = await commands.queries.getMembership(teamId, userId);
      if (existing) return existing;
      const now = nowIso();
      const row = await commands.client().team_memberships.create({ data: { id: createId("tm"), team_id: teamId, user_id: userId, roles_json: JSON.stringify(normalizeMembershipRoles(roles)), by_invite_link: byInviteLink, created_at: now, updated_at: now } });
      return membershipSnapshot(row);
    });
  }

  async ensureFallbackMembership(userId: string, bootstrapOwnerUserId: string | undefined): Promise<{ membership: TeamMembershipSnapshot; created: boolean }> {
    return this.run(async (commands) => {
      const available = await commands.queries.listAvailableMembershipsForUser(userId);
      if (available[0]) return { membership: available[0], created: false };
      await commands.lockTeam("team_default");
      const defaultTeam = await commands.queries.getTeam("team_default");
      if (!defaultTeam || !(await commands.queries.isTeamAvailable(defaultTeam.id)) || !bootstrapOwnerUserId || defaultTeam.ownerId !== bootstrapOwnerUserId) {
        throw new RelayError("default_team_unavailable", "Default Team is unavailable", 503);
      }
      const existing = await commands.queries.getMembership(defaultTeam.id, userId);
      return { membership: existing ?? await commands.grantMembership(defaultTeam.id, userId), created: !existing };
    });
  }

  async removeMembership(teamId: string, userId: string): Promise<TeamMembershipSnapshot | undefined> {
    return this.run(async (commands) => {
      await commands.lockTeam(teamId);
      const existing = await commands.queries.getMembership(teamId, userId);
      if (!existing) return undefined;
      await commands.client().team_memberships.delete({ where: { id: existing.id } });
      return existing;
    });
  }

  async transferIdentityMigrationMemberships(sourceUserId: string, survivorUserId: string): Promise<{ movedCount: number; collapsedCount: number }> {
    return this.run(async (commands) => {
      const memberships = await commands.client().team_memberships.findMany({
        where: { user_id: sourceUserId },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });
      let movedCount = 0;
      let collapsedCount = 0;
      for (const membership of memberships) {
        const survivorMembership = await commands.client().team_memberships.findUnique({
          where: { team_id_user_id: { team_id: membership.team_id, user_id: survivorUserId } },
          select: { id: true },
        });
        if (survivorMembership) {
          await commands.client().team_memberships.delete({ where: { id: membership.id } });
          collapsedCount += 1;
        } else {
          await commands.client().team_memberships.update({
            where: { id: membership.id },
            data: { user_id: survivorUserId, updated_at: nowIso() },
          });
          movedCount += 1;
        }
      }
      return Object.freeze({ movedCount, collapsedCount });
    });
  }

  async changeMembershipRoles(teamId: string, userId: string, roles: readonly string[]): Promise<TeamMembershipSnapshot | undefined> {
    return this.run(async (commands) => {
      await commands.lockTeam(teamId);
      const existing = await commands.queries.getMembership(teamId, userId);
      if (!existing) return undefined;
      return membershipSnapshot(await commands.client().team_memberships.update({ where: { id: existing.id }, data: { roles_json: JSON.stringify(normalizeMembershipRoles(roles)), updated_at: nowIso() } }));
    });
  }

  async createInviteLink(input: { teamId: string; createdByUserId: string; maxUses: number | null; activeLimitExempt?: boolean }): Promise<TeamInviteLinkSnapshot> {
    return this.run(async (commands) => {
      const now = nowIso();
      return inviteSnapshot(await commands.client().team_invite_links.create({ data: { id: createId("til"), team_id: input.teamId, created_by_user_id: input.createdByUserId, max_uses: input.maxUses, used_count: 0, active_limit_exempt: input.activeLimitExempt ? 1 : 0, status: "enabled", created_at: now, updated_at: now } }));
    });
  }

  async getOrCreateActiveInviteLink(teamId: string, createdByUserId: string, maxUses: number | null): Promise<TeamInviteLinkCreateResult> {
    return this.run(async (commands) => {
      await commands.lockTeam(teamId);
      const existing = await commands.queries.getActiveInviteLinkForCreator(teamId, createdByUserId);
      if (existing) {
        if (existing.maxUses !== maxUses) throw new RelayError("team_invite_link_max_uses_conflict", "An active invitation link already exists with a different maximum use count or capacity mode; disable it before creating a new one", 409);
        return { inviteLink: existing, outcome: "already_active" };
      }
      const now = nowIso();
      const inserted = await commands.client().$queryRaw<Array<{ id: string; team_id: string; created_by_user_id: string; max_uses: number | null; used_count: number | null; active_limit_exempt: number; status: string; created_at: string; updated_at: string }>>`
        INSERT INTO "team_invite_links" (
          "id", "team_id", "created_by_user_id", "max_uses", "used_count", "active_limit_exempt", "status", "created_at", "updated_at"
        ) VALUES (${createId("til")}, ${teamId}, ${createdByUserId}, ${maxUses}, 0, 0, 'enabled', ${now}, ${now})
        ON CONFLICT DO NOTHING
        RETURNING *`;
      if (inserted[0]) return { inviteLink: inviteSnapshot(inserted[0]), outcome: "created" };
      const concurrent = await commands.queries.getActiveInviteLinkForCreator(teamId, createdByUserId);
      if (!concurrent || concurrent.maxUses !== maxUses) throw new RelayError("team_invite_link_max_uses_conflict", "An active invitation link already exists with a different maximum use count or capacity mode; disable it before creating a new one", 409);
      return { inviteLink: concurrent, outcome: "already_active" };
    });
  }

  async disableInviteLink(inviteLinkId: string): Promise<TeamInviteLinkSnapshot | undefined> {
    return this.run(async (commands) => {
      const existing = await commands.queries.getInviteLink(inviteLinkId);
      if (!existing) return undefined;
      if (existing.status === "enabled") await commands.client().team_invite_links.update({ where: { id: inviteLinkId }, data: { status: "disabled", updated_at: nowIso() } });
      return commands.queries.getInviteLink(inviteLinkId);
    });
  }

  async consumeInviteLink(inviteLinkId: string): Promise<TeamInviteLinkSnapshot> {
    return this.run(async (commands) => {
      const rows = await commands.client().$queryRaw<Array<{ id: string; team_id: string; created_by_user_id: string; max_uses: number | null; used_count: number | null; active_limit_exempt: number; status: string; created_at: string; updated_at: string }>>`
        UPDATE "team_invite_links"
        SET "used_count" = "used_count" + 1,
            "status" = CASE WHEN "max_uses" IS NOT NULL AND "used_count" + 1 >= "max_uses" THEN 'disabled' ELSE 'enabled' END,
            "updated_at" = ${nowIso()}
        WHERE "id" = ${inviteLinkId} AND "status" = 'enabled'
          AND "used_count" IS NOT NULL AND ("max_uses" IS NULL OR "used_count" < "max_uses")
        RETURNING *`;
      if (!rows[0]) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
      return inviteSnapshot(rows[0]);
    });
  }

  async updateTeamManagementSettings(teamId: string, input: { name?: string; teamOwnerCanManageMemberApiKeyLimit?: number; teamOwnerCanManageMemberCredit?: number; teamOwnerCanCreateAccessPoint?: number }): Promise<TeamSnapshot> {
    return this.run(async (commands) => {
      const existing = await commands.queries.getTeam(teamId);
      if (!existing) throw new RelayError("team_not_found", "Team not found", 404);
      return teamSnapshot(await commands.client().teams.update({ where: { id: teamId }, data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.teamOwnerCanManageMemberApiKeyLimit === undefined ? {} : { team_owner_can_manage_member_api_key_limit: input.teamOwnerCanManageMemberApiKeyLimit }),
        ...(input.teamOwnerCanManageMemberCredit === undefined ? {} : { team_owner_can_manage_member_credit: input.teamOwnerCanManageMemberCredit }),
        ...(input.teamOwnerCanCreateAccessPoint === undefined ? {} : { team_owner_can_create_access_point: input.teamOwnerCanCreateAccessPoint }),
        updated_at: nowIso(),
      } }));
    });
  }

  async updateInviteEmailDomain(teamId: string, pattern: string | null): Promise<TeamSnapshot> {
    return this.run(async (commands) => {
      const existing = await commands.queries.getTeam(teamId);
      if (!existing) throw new RelayError("team_not_found", "Team not found", 404);
      return teamSnapshot(await commands.client().teams.update({ where: { id: teamId }, data: { invite_email_domain_pattern: pattern, updated_at: nowIso() } }));
    });
  }

  async upsertResourcePermission(input: { resourceType: string; resourceId: string; action: string; subjectType: string; subjectRef: string; subjectRole?: string | null; status?: string }): Promise<ResourcePermissionSnapshot> {
    return this.run(async (commands) => {
      if (input.resourceType === "team") await commands.lockTeam(input.resourceId);
      const subjectRole = input.subjectRole ?? null;
      const existing = await commands.client().resource_permissions.findFirst({ where: { resource_type: input.resourceType, resource_id: input.resourceId, action: input.action, subject_type: input.subjectType, subject_ref: input.subjectRef, subject_role: subjectRole } });
      if (existing) return permissionSnapshot(await commands.client().resource_permissions.update({ where: { id: existing.id }, data: { status: input.status ?? "enabled", updated_at: nowIso() } }));
      const now = nowIso();
      return permissionSnapshot(await commands.client().resource_permissions.create({ data: { id: createId("rp"), resource_type: input.resourceType, resource_id: input.resourceId, action: input.action, subject_type: input.subjectType, subject_ref: input.subjectRef, subject_role: subjectRole, status: input.status ?? "enabled", created_at: now, updated_at: now } }));
    });
  }

  async requestTeamDeletion(teamId: string, requestedByUserId: string, requestedAt = nowIso()): Promise<{ id: string; teamId: string; requestedAt: string; requestedByUserId: string; purgeNotBefore: string; archiveStatus: string; cancelledAt: string | null; purgedAt: string | null }> {
    if (teamId === "team_default") throw new RelayError("default_team_protected", "Default Team cannot be deleted", 409);
    return this.run(async (commands) => {
      await commands.lockTeam(teamId);
      const existing = await commands.client().team_deletion_lifecycles.findFirst({ where: { team_id: teamId, cancelled_at: null, purged_at: null }, orderBy: [{ requested_at: "asc" }, { id: "asc" }] });
      if (existing) return deletionSnapshot(existing);
      if (!(await commands.queries.getTeam(teamId))) throw new RelayError("team_not_found", "Team not found", 404);
      const row = await commands.client().team_deletion_lifecycles.create({ data: { id: createId("team_deletion"), team_id: teamId, requested_at: requestedAt, requested_by_user_id: requestedByUserId, purge_not_before: new Date(Date.parse(requestedAt) + 180 * 86_400_000).toISOString(), archive_status: "pending", archive_manifest_id: null, archive_manifest_object_key: null, archive_manifest_sha256: null, archive_coverage_json: null, archived_at: null, cancelled_at: null, purged_at: null } });
      await commands.client().teams.update({ where: { id: teamId }, data: { status: "disabled", updated_at: requestedAt } });
      await commands.client().team_invite_links.updateMany({ where: { team_id: teamId, status: "enabled" }, data: { status: "disabled", updated_at: requestedAt } });
      return deletionSnapshot(row);
    });
  }

  async cancelTeamDeletion(teamId: string, cancelledAt = nowIso()): Promise<{ id: string; teamId: string; requestedAt: string; requestedByUserId: string; purgeNotBefore: string; archiveStatus: string; cancelledAt: string | null; purgedAt: string | null }> {
    if (teamId === "team_default") throw new RelayError("default_team_protected", "Default Team deletion lifecycle is protected", 409);
    return this.run(async (commands) => {
      await commands.lockTeam(teamId);
      const active = await commands.client().team_deletion_lifecycles.findFirst({ where: { team_id: teamId, cancelled_at: null, purged_at: null }, orderBy: [{ requested_at: "asc" }, { id: "asc" }] });
      if (!active) throw new RelayError("team_deletion_not_active", "Team is not soft-deleted", 409);
      const row = await commands.client().team_deletion_lifecycles.update({ where: { id: active.id }, data: { cancelled_at: cancelledAt } });
      await commands.client().teams.update({ where: { id: teamId }, data: { status: "enabled", updated_at: cancelledAt } });
      return deletionSnapshot(row);
    });
  }

  async transferOwnership(input: { teamId: string; nextOwnerUserId: string; nextOwnerEnabled: boolean; actorUserId: string; appendAudit: (teamId: string, previousOwnerUserId: string, nextOwnerUserId: string) => Promise<void> }): Promise<TeamSnapshot> {
    return this.run(async (commands) => {
      await commands.lockTeam(input.teamId);
      const team = await commands.queries.getTeam(input.teamId);
      if (!team || !(await commands.queries.isTeamAvailable(input.teamId))) throw new RelayError("team_unavailable", "Team is unavailable", 409);
      if (!input.nextOwnerEnabled || !(await commands.queries.getMembership(input.teamId, input.nextOwnerUserId))) throw new RelayError("team_owner_transfer_target_invalid", "Next Team Owner must be an enabled current member", 409);
      const updated = await commands.client().teams.update({ where: { id: input.teamId }, data: { owner_id: input.nextOwnerUserId, updated_at: nowIso() } });
      await input.appendAudit(input.teamId, team.ownerId, input.nextOwnerUserId);
      return teamSnapshot(updated);
    });
  }

  private async lockTeam(teamId: string): Promise<void> {
    await this.client().$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
  }

  private async seedDefaultPermissions(teamId: string): Promise<void> {
    const roleActions: Record<string, string[]> = {
      viewer: ["team.read", "team.usage.read"],
      billing: ["team.read", "team.usage.read", "team.billing.read", "team.member.read"],
      manager: ["team.read", "team.usage.read", "team.member.read", "team.member.update"],
    };
    for (const [role, actions] of Object.entries(roleActions)) for (const action of actions) await this.upsertResourcePermission({ resourceType: "team", resourceId: teamId, action, subjectType: "team_role", subjectRef: teamId, subjectRole: role, status: "enabled" });
    await this.upsertResourcePermission({ resourceType: "team", resourceId: teamId, action: "team.invite_link.create", subjectType: "team", subjectRef: teamId, status: "disabled" });
  }
}

function teamSnapshot(row: { id: string; owner_id: string; name: string; status: string; team_owner_can_manage_member_api_key_limit: number; team_owner_can_manage_member_credit: number; team_owner_can_create_custom_provider: number; team_owner_can_create_access_point: number; invite_email_domain_pattern: string | null; created_at: string; updated_at: string }): TeamSnapshot {
  return { id: row.id, ownerId: row.owner_id, name: row.name, status: row.status, teamOwnerCanManageMemberApiKeyLimit: row.team_owner_can_manage_member_api_key_limit, teamOwnerCanManageMemberCredit: row.team_owner_can_manage_member_credit, teamOwnerCanCreateCustomProvider: row.team_owner_can_create_custom_provider, teamOwnerCanCreateAccessPoint: row.team_owner_can_create_access_point, inviteEmailDomainPattern: row.invite_email_domain_pattern, createdAt: row.created_at, updatedAt: row.updated_at };
}

function membershipSnapshot(row: { id: string; team_id: string; user_id: string; roles_json: string; by_invite_link: string | null; created_at: string; updated_at: string }): TeamMembershipSnapshot {
  return { id: row.id, teamId: row.team_id, userId: row.user_id, rolesJson: row.roles_json, byInviteLink: row.by_invite_link, createdAt: row.created_at, updatedAt: row.updated_at };
}

function inviteSnapshot(row: { id: string; team_id: string; created_by_user_id: string; max_uses: number | null; used_count: number | null; active_limit_exempt: number; status: string; created_at: string; updated_at: string }): TeamInviteLinkSnapshot {
  return { id: row.id, teamId: row.team_id, createdByUserId: row.created_by_user_id, maxUses: row.max_uses, usedCount: row.used_count, activeLimitExempt: row.active_limit_exempt, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function permissionSnapshot(row: { id: string; resource_type: string; resource_id: string; action: string; subject_type: string; subject_ref: string; subject_role: string | null; status: string; created_at: string; updated_at: string }): ResourcePermissionSnapshot {
  return { id: row.id, resourceType: row.resource_type, resourceId: row.resource_id, action: row.action, subjectType: row.subject_type, subjectRef: row.subject_ref, subjectRole: row.subject_role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function deletionSnapshot(row: { id: string; team_id: string; requested_at: string; requested_by_user_id: string; purge_not_before: string; archive_status: string; cancelled_at: string | null; purged_at: string | null }) {
  return { id: row.id, teamId: row.team_id, requestedAt: row.requested_at, requestedByUserId: row.requested_by_user_id, purgeNotBefore: row.purge_not_before, archiveStatus: row.archive_status, cancelledAt: row.cancelled_at, purgedAt: row.purged_at };
}

function membershipRoles(value: string): string[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((role): role is string => typeof role === "string") : ["viewer"]; } catch { return ["viewer"]; }
}

function normalizeMembershipRoles(roles: readonly string[]): string[] {
  const set = new Set<"viewer" | "billing" | "manager">(roles.filter((role): role is "viewer" | "billing" | "manager" => role === "viewer" || role === "billing" || role === "manager"));
  if (set.size === 0) set.add("viewer");
  return (["viewer", "billing", "manager"] as const).filter((role) => set.has(role));
}
