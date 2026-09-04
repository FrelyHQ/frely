import { PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import { AUTHORITY_CANCEL_REASON_CODES, AUTHORITY_PRODUCT_LIMITS, createId, nowIso, RelayError } from "@frely/core";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import {
  type AuthorityGrantQuotaSnapshot,
  type AuthorityGrantSnapshot,
  type AuthorityQuotaDecision,
  type AuthorityRoleDecision,
  type AuthorityUseSnapshot,
  type PageResult,
  type UserAuthorityGrantRow,
} from "./index.js";
import type {
  AuthorityContextCommands,
  AuthorityContextQueries,
  AuthorityUseResult,
  ConsumeTeamCreationUnitCommand,
  CreatePurchasedAuthorityGrantCommand,
} from "./contracts.js";

export * from "./index.js";
export * from "./hashes.js";
export type * from "./contracts.js";

type AuthorityClient = Prisma.TransactionClient;
type RootAuthorityClient = PrismaTransactionOwner & { prisma: AuthorityClient };

abstract class AuthorityInfrastructure {
  constructor(protected readonly root: RootAuthorityClient, protected readonly transaction?: AuthorityClient) {}

  protected client(): AuthorityClient { return this.transaction ?? this.root.prisma; }
}

/** Authority-owned named Prisma Queries. No mutable Prisma entity escapes. */
export class AuthorityQueries extends AuthorityInfrastructure implements AuthorityContextQueries {
  constructor(root: RootAuthorityClient, transaction?: AuthorityClient) {
    super(root, transaction);
  }

  async getGrant(grantId: string): Promise<AuthorityGrantSnapshot | undefined> {
    const row = await this.client().authority_grants.findUnique({ where: { id: grantId } });
    return row ? grantSnapshot(row) : undefined;
  }

  async getGrantForPurchase(purchaseId: string): Promise<AuthorityGrantSnapshot | undefined> {
    const row = await this.client().authority_grants.findUnique({ where: { source_purchase_id: purchaseId } });
    return row ? grantSnapshot(row) : undefined;
  }

  async getQuota(grantId: string, capabilityCode: "team.create" = "team.create"): Promise<AuthorityGrantQuotaSnapshot | undefined> {
    const row = await this.client().authority_grant_quotas.findUnique({ where: { grant_id_capability_code: { grant_id: grantId, capability_code: capabilityCode } } });
    return row ? quotaSnapshot(row) : undefined;
  }

  async getUseForOperation(beneficiaryUserId: string, operation: "team.create", idempotencyKeyHash: string): Promise<AuthorityUseSnapshot | undefined> {
    const row = await this.client().authority_uses.findUnique({ where: { beneficiary_user_id_operation_idempotency_key_hash: { beneficiary_user_id: beneficiaryUserId, operation, idempotency_key_hash: idempotencyKeyHash } } });
    return row ? useSnapshot(row) : undefined;
  }

  async decidePlatformRoles(userId: string, at = nowIso()): Promise<AuthorityRoleDecision> {
    const owner = await this.client().authority_grants.count({ where: {
      beneficiary_user_id: userId,
      role_domain: "platform",
      role_code: "owner",
      source_kind: "system_bootstrap",
      lifecycle: "active",
      effective_start: { lte: at },
      OR: [{ effective_end: null }, { effective_end: { gt: at } }],
    } });
    return Object.freeze({ userId, platformRoles: Object.freeze(owner > 0 ? ["owner" as const] : []), evaluatedAt: at });
  }

  async platformRolesForUser(userId: string, at = nowIso()): Promise<readonly string[]> {
    return (await this.decidePlatformRoles(userId, at)).platformRoles;
  }

  async activeBootstrapPlatformOwnerUserId(at = nowIso()): Promise<string | undefined> {
    const rows = await this.client().$queryRaw<Array<{ userId: string }>>`
      SELECT grant_row."beneficiary_user_id" AS "userId"
      FROM "authority_grants" grant_row
      INNER JOIN "user_controls" user_row ON user_row."id" = grant_row."beneficiary_user_id" AND user_row."status" = 'enabled'
      WHERE grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
        AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
        AND grant_row."effective_start" <= ${at}
        AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > ${at})
      ORDER BY grant_row."created_at", grant_row."id"`;
    return rows.length === 1 ? rows[0]!.userId : undefined;
  }

  async hasAvailableTeamCreationUnit(userId: string, at = nowIso()): Promise<boolean> {
    const rows = await this.client().$queryRaw<Array<{ available: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "authority_grants" grant_row
        INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = grant_row."id"
        WHERE grant_row."beneficiary_user_id" = ${userId}
          AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'creator'
          AND grant_row."lifecycle" = 'active' AND grant_row."effective_start" <= ${at}
          AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > ${at})
          AND quota."capability_code" = 'team.create'
          AND quota."granted_units" > (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id")
      ) AS "available"`;
    return rows[0]?.available === true;
  }

  async classifyIdentityMigrationUser(userId: string, at = nowIso()): Promise<{ grantCount: number; activePlatformOwner: boolean }> {
    const [grantCount, activeOwnerCount] = await Promise.all([
      this.client().authority_grants.count({ where: { beneficiary_user_id: userId } }),
      this.client().authority_grants.count({ where: {
        beneficiary_user_id: userId, role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap",
        lifecycle: "active", effective_start: { lte: at }, OR: [{ effective_end: null }, { effective_end: { gt: at } }],
      } }),
    ]);
    return Object.freeze({ grantCount, activePlatformOwner: activeOwnerCount > 0 });
  }

  async countAvailableTeamCreationUnits(userId: string, productCode?: string, at = nowIso()): Promise<number> {
    const rows = await this.client().$queryRaw<Array<{ available: bigint }>>`
      SELECT COALESCE(SUM(GREATEST(0, quota."granted_units" - (
        SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id"
      ))), 0)::bigint AS "available"
      FROM "authority_grants" grant_row
      INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = grant_row."id"
      WHERE grant_row."beneficiary_user_id" = ${userId}
        AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'creator'
        AND grant_row."lifecycle" = 'active' AND grant_row."effective_start" <= ${at}
        AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > ${at})
        AND (${productCode ?? null}::text IS NULL OR grant_row."source_product_code_snapshot" = ${productCode ?? null})
        AND quota."capability_code" = 'team.create'`;
    return safeNumber(rows[0]?.available ?? 0n);
  }

  async decideTeamCreationQuota(userId: string, at = nowIso()): Promise<AuthorityQuotaDecision> {
    const active = await this.client().$queryRaw<Array<{ grantId: string; quotaId: string; used: bigint; granted: bigint }>>`
      SELECT grant_row."id" AS "grantId", quota."id" AS "quotaId",
        (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id") AS "used",
        quota."granted_units" AS "granted"
      FROM "authority_grants" grant_row
      INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = grant_row."id"
      WHERE grant_row."beneficiary_user_id" = ${userId}
        AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'creator'
        AND grant_row."lifecycle" = 'active' AND grant_row."effective_start" <= ${at}
        AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > ${at})
        AND quota."capability_code" = 'team.create'
      ORDER BY COALESCE(grant_row."effective_end", '9999-12-31T23:59:59.999Z'), grant_row."effective_start", grant_row."created_at", grant_row."id"`;
    const candidate = active.find((row) => row.used < row.granted);
    if (candidate) return Object.freeze({ kind: "available", capabilityCode: "team.create", grantId: candidate.grantId, grantQuotaId: candidate.quotaId, unitIndex: Number(candidate.used) + 1, evaluatedAt: at });
    const states = await this.client().authority_grants.findMany({ where: { beneficiary_user_id: userId, role_domain: "platform", role_code: "creator" }, select: { lifecycle: true, effective_end: true } });
    const kind = states.length > 0 && states.every((row) => row.lifecycle === "canceled") ? "canceled"
      : states.some((row) => row.lifecycle === "active" && row.effective_end !== null && row.effective_end <= at) ? "expired" : "exhausted";
    return Object.freeze({ kind, capabilityCode: "team.create", grantId: null, grantQuotaId: null, unitIndex: null, evaluatedAt: at });
  }

  async pageUserGrants(userId: string, page = 1, at = nowIso(), requestedPageSize = 20): Promise<PageResult<UserAuthorityGrantRow>> {
    const pageSize = normalizePageSize(requestedPageSize);
    const total = await this.client().authority_grants.count({ where: { beneficiary_user_id: userId, role_domain: "platform", role_code: "creator" } });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(Math.max(1, Math.trunc(page)), totalPages);
    const rows = await this.client().$queryRaw<Array<{
      id: string; sourceKind: string; productCode: string | null; productVersion: number | null;
      effectiveStart: string; effectiveEnd: string | null; lifecycle: string; capabilityCode: string;
      grantedUnits: bigint; usedUnits: bigint; availableUnits: bigint;
    }>>`
      SELECT grant_row."id", grant_row."source_kind" AS "sourceKind",
        grant_row."source_product_code_snapshot" AS "productCode",
        grant_row."source_product_version_snapshot" AS "productVersion",
        grant_row."effective_start" AS "effectiveStart", grant_row."effective_end" AS "effectiveEnd",
        grant_row."lifecycle", quota."capability_code" AS "capabilityCode", quota."granted_units" AS "grantedUnits",
        (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id") AS "usedUnits",
        CASE WHEN grant_row."lifecycle" = 'active' AND grant_row."effective_start" <= ${at}
          AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > ${at})
          THEN GREATEST(0, quota."granted_units" - (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id"))
          ELSE 0 END AS "availableUnits"
      FROM "authority_grants" grant_row
      INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = grant_row."id"
      WHERE grant_row."beneficiary_user_id" = ${userId}
        AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'creator'
      ORDER BY COALESCE(grant_row."effective_end", '9999-12-31T23:59:59.999Z'), grant_row."created_at", grant_row."id"
      LIMIT ${pageSize} OFFSET ${(normalizedPage - 1) * pageSize}`;
    return {
      items: rows.map((row) => ({ ...row, grantedUnits: safeNumber(row.grantedUnits), usedUnits: safeNumber(row.usedUnits), availableUnits: safeNumber(row.availableUnits) })),
      page: normalizedPage, pageSize, total, totalPages,
    };
  }
}

/** Authority-owned named Prisma Commands. Root methods own one short transaction. */
export class AuthorityCommands extends AuthorityInfrastructure implements AuthorityContextCommands {
  private readonly queries: AuthorityQueries;

  constructor(root: RootAuthorityClient, transaction?: AuthorityClient, private readonly auditAppender: AuditEventAppender = new PrismaAuditEventAppender()) {
    super(root, transaction);
    this.queries = new AuthorityQueries(root, transaction);
  }

  private run<T>(callback: (commands: AuthorityCommands) => Promise<T>, maxAttempts = 3, isolationLevel: "ReadCommitted" | "Serializable" = "ReadCommitted"): Promise<T> {
    if (this.transaction) return callback(this);
    return this.root.withPrismaTransaction(
      (transaction) => callback(new AuthorityCommands(this.root, transaction, this.auditAppender)),
      maxAttempts,
      { isolationLevel },
    );
  }

  async ensureBootstrapOwner(userId: string, actor: { actorType: "system" | "user"; actorId: string } = { actorType: "system", actorId: "bootstrap" }): Promise<{ grant: AuthorityGrantSnapshot; created: boolean }> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "user_controls" WHERE "id" = ${userId} AND "status" = 'enabled' FOR UPDATE`;
      const user = await commands.client().user_controls.findUnique({ where: { id: userId }, select: { status: true } });
      if (!user || user.status !== "enabled") throw new RelayError("user_not_found", "Enabled Platform Owner user not found", 404);
      const existing = await commands.client().authority_grants.findFirst({ where: { beneficiary_user_id: userId, role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap", lifecycle: "active" } });
      if (existing) return { grant: grantSnapshot(existing), created: false };
      const current = await commands.queries.activeBootstrapPlatformOwnerUserId();
      if (current && current !== userId) throw new RelayError("platform_owner_already_exists", "An enabled Platform Owner already exists", 409);
      const now = nowIso();
      const row = await commands.client().authority_grants.create({ data: {
        id: createId("authority_grant"), beneficiary_user_id: userId, role_domain: "platform", role_code: "owner", role_scope_id: null,
        source_kind: "system_bootstrap", source_purchase_id: null, source_product_code_snapshot: null, source_product_version_snapshot: null,
        source_origin_id_snapshot: null, max_current_owned_teams_snapshot: null, max_lifetime_created_teams_snapshot: null,
        issued_by_user_id: null, effective_start: now, effective_end: null, lifecycle: "active", canceled_at: null,
        canceled_by_user_id: null, cancel_reason_code: null, created_at: now,
      } });
      await commands.auditAppender.append(commands.client(), { actor, action: "authority_grant.bootstrap", resourceType: "authority_grant", resourceId: row.id, result: "success", source: "system", requestId: null, metadata: { beneficiaryUserId: userId, sourceKind: "system_bootstrap" } });
      return { grant: grantSnapshot(row), created: true };
    }, 3, "Serializable");
  }

  async createPurchasedGrant(command: CreatePurchasedAuthorityGrantCommand): Promise<{ grant: AuthorityGrantSnapshot; quota: AuthorityGrantQuotaSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const existing = await commands.client().authority_grants.findUnique({ where: { source_purchase_id: command.purchaseId } });
      if (existing) {
        const quota = await commands.queries.getQuota(existing.id);
        if (!quota) throw new RelayError("authority_purchase_corrupt", "Authority Purchase quota is missing", 500);
        return { grant: grantSnapshot(existing), quota, replayed: true };
      }
      const grantUnits = boundedPositiveInt(command.grantedUnits, AUTHORITY_PRODUCT_LIMITS.maxGrantUnits, "authority_grant_units_invalid");
      const now = command.effectiveStart;
      const grant = await commands.client().authority_grants.create({ data: {
        id: createId("authority_grant"), beneficiary_user_id: command.beneficiaryUserId,
        role_domain: "platform", role_code: "creator", role_scope_id: null,
        source_kind: "product_purchase", source_purchase_id: command.purchaseId,
        source_product_code_snapshot: command.productCode, source_product_version_snapshot: command.productVersion,
        source_origin_id_snapshot: command.purchaseId,
        max_current_owned_teams_snapshot: command.maxCurrentOwnedTeams,
        max_lifetime_created_teams_snapshot: command.maxLifetimeCreatedTeams,
        issued_by_user_id: command.issuedByUserId,
        effective_start: command.effectiveStart, effective_end: command.effectiveEnd, lifecycle: "active",
        canceled_at: null, canceled_by_user_id: null, cancel_reason_code: null, created_at: now,
      } });
      const quota = await commands.client().authority_grant_quotas.create({ data: { id: createId("authority_quota"), grant_id: grant.id, capability_code: "team.create", granted_units: BigInt(grantUnits), created_at: now } });
      return { grant: grantSnapshot(grant), quota: quotaSnapshot(quota), replayed: false };
    }, 3, "Serializable");
  }

  async cancelGrant(input: { grantId: string; actorOwnerUserId: string; reasonCode: string; requestId?: string | null }): Promise<AuthorityGrantSnapshot> {
    return this.run(async (commands) => {
      requireCancelReason(input.reasonCode);
      await commands.client().$queryRaw`SELECT "id" FROM "authority_grants" WHERE "id" = ${input.grantId} FOR UPDATE`;
      const grant = await commands.client().authority_grants.findUnique({ where: { id: input.grantId } });
      if (!grant) throw new RelayError("authority_grant_not_found", "Authority Grant not found", 404);
      if (grant.source_kind === "system_bootstrap") throw new RelayError("authority_owner_cancel_blocked", "Bootstrap Owner Grant requires offline handover", 409);
      if (grant.lifecycle === "canceled") {
        if (grant.cancel_reason_code !== input.reasonCode) throw new RelayError("authority_cancel_conflict", "Authority Grant was already canceled with another reason", 409);
        return grantSnapshot(grant);
      }
      const updated = await commands.client().authority_grants.update({ where: { id: grant.id }, data: { lifecycle: "canceled", canceled_at: nowIso(), canceled_by_user_id: input.actorOwnerUserId, cancel_reason_code: input.reasonCode } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "authority_grant.cancel", resourceType: "authority_grant", resourceId: grant.id, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { reasonCode: input.reasonCode, sourceKind: grant.source_kind } });
      return grantSnapshot(updated);
    }, 3, "Serializable");
  }

  async cancelUnconsumedGrantForRefund(input: { grantId: string; purchaseId: string; actorOwnerUserId: string; requestId?: string | null }): Promise<AuthorityGrantSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "authority_grants" WHERE "id" = ${input.grantId} FOR UPDATE`;
      const grant = await commands.client().authority_grants.findUnique({ where: { id: input.grantId } });
      if (!grant || grant.source_kind !== "product_purchase" || grant.source_purchase_id !== input.purchaseId) throw new RelayError("authority_grant_not_refundable", "Authority Grant is not refundable", 409);
      if (grant.lifecycle !== "active") throw new RelayError("authority_grant_not_refundable", "Canceled Authority Grant cannot be refunded", 409);
      const used = await commands.client().authority_uses.count({ where: { authority_grant_quotas: { grant_id: grant.id } } });
      if (used > 0) throw new RelayError("authority_grant_already_used", "Consumed Authority Grant cannot be refunded", 409);
      const updated = await commands.client().authority_grants.update({ where: { id: grant.id }, data: { lifecycle: "canceled", canceled_at: nowIso(), canceled_by_user_id: input.actorOwnerUserId, cancel_reason_code: "refund" } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "authority_grant.cancel", resourceType: "authority_grant", resourceId: grant.id, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { reasonCode: "refund", sourceKind: grant.source_kind } });
      return grantSnapshot(updated);
    }, 3, "Serializable");
  }

  /** Transaction-bound Authority participant. Identity validates both Users before this call. */
  async handoverBootstrapOwner(input: { currentOwnerUserId: string; nextOwnerUserId: string; actorUserId: string; at?: string }): Promise<{ previousGrant: AuthorityGrantSnapshot; nextGrant: AuthorityGrantSnapshot }> {
    return this.run(async (commands) => {
      const at = input.at ?? nowIso();
      await commands.client().$queryRaw`SELECT "id" FROM "authority_grants" WHERE "source_kind" = 'system_bootstrap' AND "lifecycle" = 'active' ORDER BY "id" FOR UPDATE`;
      const current = await commands.client().authority_grants.findFirst({ where: { beneficiary_user_id: input.currentOwnerUserId, role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap", lifecycle: "active" } });
      if (!current) throw new RelayError("platform_owner_not_found", "Current Platform Owner Grant not found", 404);
      if (input.currentOwnerUserId === input.nextOwnerUserId) throw new RelayError("platform_owner_handover_invalid", "Next Platform Owner must be a different user", 400);
      const previous = await commands.client().authority_grants.update({ where: { id: current.id }, data: { lifecycle: "canceled", canceled_at: at, canceled_by_user_id: input.actorUserId, cancel_reason_code: "owner_handover" } });
      const next = await commands.client().authority_grants.create({ data: {
        id: createId("authority_grant"), beneficiary_user_id: input.nextOwnerUserId, role_domain: "platform", role_code: "owner", role_scope_id: null,
        source_kind: "system_bootstrap", source_purchase_id: null, source_product_code_snapshot: null, source_product_version_snapshot: null,
        source_origin_id_snapshot: null, max_current_owned_teams_snapshot: null, max_lifetime_created_teams_snapshot: null,
        issued_by_user_id: input.actorUserId, effective_start: at, effective_end: null, lifecycle: "active", canceled_at: null,
        canceled_by_user_id: null, cancel_reason_code: null, created_at: at,
      } });
      const count = await commands.client().authority_grants.count({ where: { role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap", lifecycle: "active" } });
      if (count !== 1) throw new RelayError("platform_owner_invariant_failed", "Platform Owner handover did not preserve exactly one active Grant", 500);
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorUserId }, action: "platform_owner.handover", resourceType: "authority_grant", resourceId: next.id, result: "success", source: "owner", requestId: null, metadata: { previousOwnerUserId: input.currentOwnerUserId, nextOwnerUserId: input.nextOwnerUserId, previousGrantId: current.id } });
      return { previousGrant: grantSnapshot(previous), nextGrant: grantSnapshot(next) };
    }, 1, "Serializable");
  }

  /** Transaction-bound append-only participant. Tenancy creates the Team in the same root transaction. */
  async consumeTeamCreationUnit(command: ConsumeTeamCreationUnitCommand): Promise<AuthorityUseResult> {
    return this.run(async (commands) => {
      const prior = await commands.queries.getUseForOperation(command.beneficiaryUserId, "team.create", command.idempotencyKeyHash);
      if (prior) {
        if (prior.requestHash !== command.requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Team request", 409);
        return { use: prior, replayed: true };
      }
      if (!Number.isSafeInteger(command.currentOwnedTeams) || command.currentOwnedTeams < 0) throw new RelayError("authority_team_count_invalid", "Current Team count is invalid", 500);
      if (command.currentOwnedTeams >= AUTHORITY_PRODUCT_LIMITS.maxTeamLimit) throw new RelayError("authority_team_limit_exceeded", "Platform Team creation safety limit reached", 409);
      const at = command.createdAt ?? nowIso();
      const candidates = await commands.client().$queryRaw<Array<{
        quotaId: string; grantedUnits: bigint; maxCurrentOwnedTeams: number | null; maxLifetimeCreatedTeams: number | null; sourceProductCode: string | null;
      }>>`
        SELECT quota."id" AS "quotaId", quota."granted_units" AS "grantedUnits",
          grant_row."max_current_owned_teams_snapshot" AS "maxCurrentOwnedTeams",
          grant_row."max_lifetime_created_teams_snapshot" AS "maxLifetimeCreatedTeams",
          grant_row."source_product_code_snapshot" AS "sourceProductCode"
        FROM "authority_grants" grant_row
        INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = grant_row."id"
        WHERE grant_row."beneficiary_user_id" = ${command.beneficiaryUserId}
          AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'creator'
          AND grant_row."lifecycle" = 'active' AND grant_row."effective_start" <= ${at}
          AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > ${at})
          AND quota."capability_code" = 'team.create'
          AND quota."granted_units" > (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id")
        ORDER BY COALESCE(grant_row."effective_end", '9999-12-31T23:59:59.999Z'), grant_row."effective_start", grant_row."created_at", grant_row."id"
        FOR UPDATE OF grant_row, quota`;
      if (candidates.length === 0) throw quotaUnavailable(await commands.queries.decideTeamCreationQuota(command.beneficiaryUserId, at));
      const lifetimeCreated = await commands.client().authority_uses.count({ where: { beneficiary_user_id: command.beneficiaryUserId, operation: "team.create" } });
      if (lifetimeCreated >= AUTHORITY_PRODUCT_LIMITS.maxTeamLimit) throw new RelayError("authority_team_limit_exceeded", "Platform Team creation safety limit reached", 409);
      let selected: typeof candidates[number] | undefined;
      for (const candidate of candidates) {
        if (candidate.maxCurrentOwnedTeams !== null && command.currentOwnedTeams >= candidate.maxCurrentOwnedTeams) continue;
        const productLifetime = await commands.client().$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS "count" FROM "authority_uses" use_row
          INNER JOIN "authority_grant_quotas" quota ON quota."id" = use_row."grant_quota_id"
          INNER JOIN "authority_grants" grant_row ON grant_row."id" = quota."grant_id"
          WHERE use_row."beneficiary_user_id" = ${command.beneficiaryUserId}
            AND grant_row."source_product_code_snapshot" IS NOT DISTINCT FROM ${candidate.sourceProductCode}`;
        if (candidate.maxLifetimeCreatedTeams !== null && safeNumber(productLifetime[0]?.count ?? 0n) >= candidate.maxLifetimeCreatedTeams) continue;
        selected = candidate;
        break;
      }
      if (!selected) throw new RelayError("authority_team_limit_exceeded", "Every available Team creation unit is blocked by its frozen Team limit", 409);
      const used = await commands.client().authority_uses.count({ where: { grant_quota_id: selected.quotaId } });
      if (BigInt(used) >= selected.grantedUnits) throw new RelayError("authority_quota_exhausted", "No active Team creation unit is available", 409);
      const row = await commands.client().authority_uses.create({ data: {
        id: createId("authority_use"), grant_quota_id: selected.quotaId, unit_index: used + 1,
        beneficiary_user_id: command.beneficiaryUserId, operation: "team.create", idempotency_key_hash: command.idempotencyKeyHash,
        request_hash: command.requestHash, target_type: "team", target_id_snapshot: command.targetTeamId,
        actor_user_id: command.actorUserId, created_at: at,
      } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: command.actorUserId }, action: "authority_grant.consume", resourceType: "authority_use", resourceId: row.id, result: "success", source: command.source, requestId: command.requestId ?? null, metadata: { grantQuotaId: selected.quotaId, teamId: command.targetTeamId, ownerUserId: command.beneficiaryUserId } });
      return { use: useSnapshot(row), replayed: false };
    }, 3, "Serializable");
  }
}

function grantSnapshot(row: {
  id: string; beneficiary_user_id: string; role_domain: string; role_code: string; source_kind: string;
  source_purchase_id: string | null; source_product_code_snapshot: string | null; source_product_version_snapshot: number | null;
  source_origin_id_snapshot: string | null; max_current_owned_teams_snapshot: number | null; max_lifetime_created_teams_snapshot: number | null;
  issued_by_user_id: string | null; effective_start: string; effective_end: string | null; lifecycle: string;
  canceled_at: string | null; canceled_by_user_id: string | null; cancel_reason_code: string | null; created_at: string;
}): AuthorityGrantSnapshot {
  return {
    id: row.id, beneficiaryUserId: row.beneficiary_user_id, roleDomain: row.role_domain as "platform", roleCode: row.role_code as "owner" | "creator",
    sourceKind: row.source_kind as AuthorityGrantSnapshot["sourceKind"], sourcePurchaseId: row.source_purchase_id,
    sourceProductCodeSnapshot: row.source_product_code_snapshot, sourceProductVersionSnapshot: row.source_product_version_snapshot,
    sourceOriginIdSnapshot: row.source_origin_id_snapshot, maxCurrentOwnedTeamsSnapshot: row.max_current_owned_teams_snapshot,
    maxLifetimeCreatedTeamsSnapshot: row.max_lifetime_created_teams_snapshot, issuedByUserId: row.issued_by_user_id,
    effectiveStart: row.effective_start, effectiveEnd: row.effective_end, lifecycle: row.lifecycle as AuthorityGrantSnapshot["lifecycle"],
    canceledAt: row.canceled_at, canceledByUserId: row.canceled_by_user_id, cancelReasonCode: row.cancel_reason_code, createdAt: row.created_at,
  };
}

function quotaSnapshot(row: { id: string; grant_id: string; capability_code: string; granted_units: bigint; created_at: string }): AuthorityGrantQuotaSnapshot {
  return { id: row.id, grantId: row.grant_id, capabilityCode: row.capability_code as "team.create", grantedUnits: safeNumber(row.granted_units), createdAt: row.created_at };
}

function useSnapshot(row: { id: string; grant_quota_id: string; unit_index: number; beneficiary_user_id: string; operation: string; idempotency_key_hash: string; request_hash: string; target_type: string; target_id_snapshot: string; actor_user_id: string; created_at: string }): AuthorityUseSnapshot {
  return { id: row.id, grantQuotaId: row.grant_quota_id, unitIndex: row.unit_index, beneficiaryUserId: row.beneficiary_user_id, operation: row.operation as "team.create", idempotencyKeyHash: row.idempotency_key_hash, requestHash: row.request_hash, targetType: row.target_type as "team", targetIdSnapshot: row.target_id_snapshot, actorUserId: row.actor_user_id, createdAt: row.created_at };
}

function safeNumber(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RelayError("authority_integer_out_of_range", "Authority integer is outside the supported range", 500);
  return result;
}

function normalizePageSize(value: number): number {
  return [10, 20, 50, 100].includes(value) ? value : 20;
}

function boundedPositiveInt(value: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RelayError(code, "Authority value is outside its accepted range", 400);
  return value;
}

function requireCancelReason(reasonCode: string): void {
  if (!(AUTHORITY_CANCEL_REASON_CODES as readonly string[]).includes(reasonCode)) throw new RelayError("authority_cancel_reason_invalid", "Authority Grant cancel reason is invalid", 400);
}

function quotaUnavailable(decision: AuthorityQuotaDecision): RelayError {
  if (decision.kind === "canceled") return new RelayError("authority_grant_canceled", "Every Team creation Grant is canceled", 409);
  if (decision.kind === "expired") return new RelayError("authority_grant_expired", "Every remaining Team creation Grant is expired", 409);
  return new RelayError("authority_quota_exhausted", "No active Team creation unit is available", 409);
}
