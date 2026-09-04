import { createHash } from "node:crypto";
import { PrismaAuditEventAppender, type AuditEventAppender } from "@frely/audit/application-internal";
import { createId, isRuntimeScopeRef, nowIso, parseScopeRef, RelayError, type ScopeRef } from "@frely/core";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import {
  allApiKeyPlanSources,
  restrictedApiKeyPlanSources,
  type ApiKeyPlanSourceRestrictionDecision,
  type AccessPointAllowanceDecision,
  type PartnerOperatingDecision,
  type PartnerOperatingEntitlementSnapshot,
  type PlanAccessPointEntitlementSnapshot,
  type PlanDefinitionSnapshot,
  type PlanSubscriptionSnapshot,
  type TeamProviderAccessDecision,
  type TeamProviderAccessStateSnapshot,
  type TeamProviderEntitlementSnapshot,
  deniedAccessPointAllowance,
  paidAccessPointAllowance,
  PERSONAL_PROVIDER_AP_LIMIT,
  SECONDS_PER_DAY,
  personalProviderRenewalWindow,
  personalProviderSlotLifecycle,
  positiveDurationDays,
  type PersonalProviderEntitlementPeriodSnapshot,
  type PersonalProviderSlotAccessDecision,
  type PersonalProviderSlotSnapshot,
} from "./index.js";
import type {
  CreatePlanDefinitionCommand,
  CreatePlanSubscriptionCommand,
  CursorPageResult,
  EntitlementContextCommands,
  EntitlementContextQueries,
  PlanBudgetLimitInput,
  PlanBudgetLimitSnapshot,
  RevisePlanDefinitionCommand,
  ReviseSubscriptionCompatibilityCommand,
  TeamProviderEntitlementHistoryRow,
} from "./contracts.js";

export * from "./index.js";
export type * from "./contracts.js";

type EntitlementClient = Prisma.TransactionClient;
type RootEntitlementClient = PrismaTransactionOwner & { prisma: EntitlementClient };

abstract class EntitlementInfrastructure {
  constructor(protected readonly root: RootEntitlementClient, protected readonly transaction?: EntitlementClient) {}

  protected client(): EntitlementClient { return this.transaction ?? this.root.prisma; }
}

/** Entitlement-owned named Queries and immutable compatibility Decisions. */
export class EntitlementQueries extends EntitlementInfrastructure implements EntitlementContextQueries {
  constructor(root: RootEntitlementClient, transaction?: EntitlementClient) {
    super(root, transaction);
  }

  async getPlan(planId: string): Promise<PlanDefinitionSnapshot | undefined> {
    const row = await this.client().plans.findUnique({ where: { id: planId } });
    return row ? planSnapshot(row) : undefined;
  }

  async getSubscription(subscriptionId: string): Promise<PlanSubscriptionSnapshot | undefined> {
    const row = await this.client().plan_subscriptions.findUnique({ where: { id: subscriptionId } });
    return row ? subscriptionSnapshot(row) : undefined;
  }

  async classifyIdentityMigrationUser(userId: string): Promise<{ unsafeReferenceCount: number }> {
    const userScopeRef = `user:${userId}`;
    const [plans, subscriptions, userModelScopes] = await Promise.all([
      this.client().plans.count({ where: { OR: [{ owner_id: userId }, { scope_ref: userScopeRef }] } }),
      this.client().plan_subscriptions.count({ where: { scope_ref: userScopeRef } }),
      this.client().user_model_plan_scope_orders.count({ where: { subscription_scope_ref: userScopeRef } }),
    ]);
    return Object.freeze({ unsafeReferenceCount: plans + subscriptions + userModelScopes });
  }

  async listPlanAccessPoints(planId: string): Promise<PlanAccessPointEntitlementSnapshot[]> {
    return (await this.client().plan_access_points.findMany({ where: { plan_id: planId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] })).map(planAccessPointSnapshot);
  }

  async listPlanBudgetLimitsForPlans(planIds: readonly string[]): Promise<Map<string, PlanBudgetLimitSnapshot[]>> {
    const ids = [...new Set(planIds)];
    const result = new Map(ids.map((id) => [id, [] as PlanBudgetLimitSnapshot[]]));
    if (ids.length === 0) return result;
    const rows = await this.client().plan_budget_limits.findMany({ where: { plan_id: { in: ids } }, orderBy: [{ plan_id: "asc" }, { limit_scope: "asc" }, { metric: "asc" }, { window_type: "asc" }, { window_seconds: "asc" }, { limit_value: "asc" }, { id: "asc" }] });
    for (const row of rows) result.get(row.plan_id)!.push(limitSnapshot(row));
    return result;
  }

  async findActivePlanSubscriptions(scopeRef: ScopeRef, at = nowIso()): Promise<PlanSubscriptionSnapshot[]> {
    const rows = await this.client().plan_subscriptions.findMany({
      where: { scope_ref: scopeRef, subscription_lifecycle: "active", effective_start: { lte: at }, OR: [{ effective_end: null }, { effective_end: { gt: at } }], plans: { plan_status: { in: ["enabled", "closed"] } } },
      orderBy: [{ priority: "asc" }, { effective_start: "asc" }, { created_at: "asc" }, { id: "asc" }],
    });
    return rows.map(subscriptionSnapshot);
  }

  async decideAccessPointAllowance(scopeRef: ScopeRef, at = nowIso()): Promise<AccessPointAllowanceDecision> {
    const scope = parseScopeRef(scopeRef);
    let entitled = false;
    if (scope.scopeType === "team") {
      entitled = (await this.client().team_provider_entitlements.count({ where: {
        team_id: scope.scopeId,
        source_kind: "product_purchase",
        source_authority_purchase_id: { not: null },
        lifecycle: "active",
        effective_start: { lte: at },
        OR: [{ effective_end: null }, { effective_end: { gt: at } }],
      } })) > 0;
    } else if (scope.scopeType === "user") {
      entitled = (await this.client().user_provider_entitlement_periods.count({ where: {
        user_id: scope.scopeId,
        lifecycle: "active",
        effective_start: { lte: at },
        effective_end: { gt: at },
      } })) > 0;
    }
    return entitled ? paidAccessPointAllowance(scopeRef) : deniedAccessPointAllowance(scopeRef);
  }

  async decideApiKeyPlanSourceRestriction(apiKeyId: string): Promise<ApiKeyPlanSourceRestrictionDecision> {
    const marker = await this.client().$queryRaw<Array<{ apiKeyId: string }>>`
      SELECT "api_key_id" AS "apiKeyId"
      FROM "api_key_plan_source_restrictions"
      WHERE "api_key_id" = ${apiKeyId}
    `;
    if (marker.length === 0) return allApiKeyPlanSources(apiKeyId);
    const [sourceRows, teamRows] = await Promise.all([
      this.client().$queryRaw<Array<{ planId: string; subscriptionScopeRef: string }>>`
        SELECT "plan_id" AS "planId", "subscription_scope_ref" AS "subscriptionScopeRef"
        FROM "api_key_plan_source_selections"
        WHERE "api_key_id" = ${apiKeyId}
        ORDER BY "plan_id" ASC, "subscription_scope_ref" ASC, "id" ASC
      `,
      this.client().$queryRaw<Array<{ teamId: string }>>`
        SELECT "team_id" AS "teamId"
        FROM "api_key_team_scope_selections"
        WHERE "api_key_id" = ${apiKeyId}
        ORDER BY "team_id" ASC, "id" ASC
      `,
    ]);
    return restrictedApiKeyPlanSources(
      apiKeyId,
      sourceRows.map((row) => ({ planId: row.planId, subscriptionScopeRef: row.subscriptionScopeRef as ScopeRef })),
      teamRows.map((row) => `team:${row.teamId}` as ScopeRef),
    );
  }

  async pageApiKeyPlanSourceRestrictionCandidates(
    apiKeyId: string,
    input: { query?: string; page?: number; pageSize?: number } = {},
    at = nowIso(),
  ): Promise<import("./index.js").ApiKeyPlanSourceRestrictionCandidatePage> {
    const keyRows = await this.client().$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT "user_id" AS "ownerUserId" FROM "api_keys" WHERE "id" = ${apiKeyId}
    `;
    const ownerUserId = keyRows[0]?.ownerUserId;
    if (!ownerUserId) throw new RelayError("api_key_not_found", "API key not found", 404);
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizePageSize(input.pageSize ?? 20);
    const page = Math.max(1, Math.min(10_000, Number.isSafeInteger(input.page) && (input.page ?? 0) > 0 ? input.page! : 1));
    const offset = (page - 1) * pageSize;
    const [sourceRows, teamRows] = await Promise.all([
      this.client().$queryRaw<Array<{ planId: string; planName: string; planVersion: number; scopeRef: string; current: boolean; selected: boolean }>>`
        WITH scopes AS (
          SELECT 'global:'::text AS "scopeRef"
          UNION ALL SELECT 'user:' || ${ownerUserId}
          UNION ALL SELECT 'team:' || membership."team_id"
          FROM "team_memberships" membership
          INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
          WHERE membership."user_id" = ${ownerUserId}
            AND NOT EXISTS (
              SELECT 1 FROM "team_deletion_lifecycles" deletion
              WHERE deletion."team_id" = membership."team_id"
                AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
            )
        ), current_sources AS (
          SELECT subscription."plan_id" AS "planId", subscription."scope_ref" AS "scopeRef"
          FROM scopes
          INNER JOIN "plan_subscriptions" subscription
            ON subscription."scope_ref" = scopes."scopeRef"
            AND subscription."subscription_lifecycle" = 'active'
            AND subscription."effective_start" <= ${at}
            AND (subscription."effective_end" IS NULL OR subscription."effective_end" > ${at})
          INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
          INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
          INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
          GROUP BY subscription."plan_id", subscription."scope_ref"
        ), candidates AS (
          SELECT "planId", "scopeRef", TRUE AS "current" FROM current_sources
          UNION
          SELECT selection."plan_id", selection."subscription_scope_ref", FALSE
          FROM "api_key_plan_source_selections" selection
          WHERE selection."api_key_id" = ${apiKeyId}
            AND NOT EXISTS (
              SELECT 1 FROM current_sources current_source
              WHERE current_source."planId" = selection."plan_id" AND current_source."scopeRef" = selection."subscription_scope_ref"
            )
        )
        SELECT candidate."planId", plan."name" AS "planName", plan."version" AS "planVersion", candidate."scopeRef",
          candidate."current",
          EXISTS (
            SELECT 1 FROM "api_key_plan_source_selections" selection
            WHERE selection."api_key_id" = ${apiKeyId}
              AND selection."plan_id" = candidate."planId"
              AND selection."subscription_scope_ref" = candidate."scopeRef"
          ) AS "selected"
        FROM candidates candidate
        INNER JOIN "plans" plan ON plan."id" = candidate."planId"
        WHERE ${query} = '' OR position(${query} IN lower(plan."name")) > 0 OR position(${query} IN lower(candidate."scopeRef")) > 0 OR position(${query} IN lower(candidate."planId")) > 0
        ORDER BY plan."name" ASC, plan."version" DESC, candidate."scopeRef" ASC, candidate."planId" ASC
        LIMIT ${pageSize + 1} OFFSET ${offset}
      `,
      this.client().$queryRaw<Array<{ teamId: string; teamName: string; current: boolean; selected: boolean }>>`
        WITH scopes AS (
          SELECT 'team:' || membership."team_id" AS "scopeRef"
          FROM "team_memberships" membership
          INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
          WHERE membership."user_id" = ${ownerUserId}
            AND NOT EXISTS (
              SELECT 1 FROM "team_deletion_lifecycles" deletion
              WHERE deletion."team_id" = membership."team_id"
                AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
            )
        ), current_teams AS (
          SELECT DISTINCT substring(subscription."scope_ref" FROM 6) AS "teamId"
          FROM scopes
          INNER JOIN "plan_subscriptions" subscription ON subscription."scope_ref" = scopes."scopeRef"
            AND subscription."subscription_lifecycle" = 'active'
            AND subscription."effective_start" <= ${at}
            AND (subscription."effective_end" IS NULL OR subscription."effective_end" > ${at})
          INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
          INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
          INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
        ), candidates AS (
          SELECT "teamId", TRUE AS "current" FROM current_teams
          UNION
          SELECT selection."team_id", FALSE FROM "api_key_team_scope_selections" selection WHERE selection."api_key_id" = ${apiKeyId}
            AND NOT EXISTS (SELECT 1 FROM current_teams current_team WHERE current_team."teamId" = selection."team_id")
        )
        SELECT candidate."teamId", team."name" AS "teamName", candidate."current",
          EXISTS (SELECT 1 FROM "api_key_team_scope_selections" selection WHERE selection."api_key_id" = ${apiKeyId} AND selection."team_id" = candidate."teamId") AS "selected"
        FROM candidates candidate
        INNER JOIN "teams" team ON team."id" = candidate."teamId"
        WHERE ${query} = '' OR position(${query} IN lower(team."name")) > 0 OR position(${query} IN lower(candidate."teamId")) > 0
        ORDER BY team."name" ASC, candidate."teamId" ASC
        LIMIT ${pageSize + 1} OFFSET ${offset}
      `,
    ]);
    const sources = sourceRows.slice(0, pageSize).map((row) => ({
      planId: row.planId,
      planName: row.planName,
      planVersion: row.planVersion,
      subscriptionScopeRef: row.scopeRef as ScopeRef,
      current: Boolean(row.current),
      selected: Boolean(row.selected),
    }));
    const teams = teamRows.slice(0, pageSize).map((row) => ({
      teamId: row.teamId,
      teamName: row.teamName,
      scopeRef: `team:${row.teamId}` as ScopeRef,
      current: Boolean(row.current),
      selected: Boolean(row.selected),
    }));
    return Object.freeze({
      apiKeyId,
      sources: Object.freeze(sources),
      teams: Object.freeze(teams),
      page,
      pageSize,
      hasMoreSources: sourceRows.length > pageSize,
      hasMoreTeams: teamRows.length > pageSize,
      nextPage: sourceRows.length > pageSize || teamRows.length > pageSize ? page + 1 : null,
    });
  }

  async getTeamProviderAccessState(teamId: string, at = nowIso()): Promise<TeamProviderAccessStateSnapshot> {
    return (await this.getTeamProviderAccessStates([teamId], at)).get(teamId)!;
  }

  async getTeamProviderAccessStates(teamIds: readonly string[], at = nowIso()): Promise<ReadonlyMap<string, TeamProviderAccessStateSnapshot>> {
    const ids = [...new Set(teamIds)];
    const result = new Map<string, TeamProviderAccessStateSnapshot>();
    if (ids.length === 0) return result;
    const rows = (await this.client().team_provider_entitlements.findMany({
      where: { team_id: { in: ids } },
      orderBy: [{ team_id: "asc" }, { effective_start: "asc" }, { id: "asc" }],
    })).map(teamProviderSnapshot);
    const rowsByTeam = new Map(ids.map((id) => [id, [] as TeamProviderEntitlementSnapshot[]]));
    for (const row of rows) rowsByTeam.get(row.teamId)!.push(row);
    for (const id of ids) result.set(id, teamProviderAccessState(rowsByTeam.get(id)!, at));
    return result;
  }

  async decideTeamProviderAccess(teamId: string, at = nowIso()): Promise<TeamProviderAccessDecision> {
    return (await this.decideTeamProviderAccesses([teamId], at)).get(teamId)!;
  }

  async decideTeamProviderAccesses(teamIds: readonly string[], at = nowIso()): Promise<ReadonlyMap<string, TeamProviderAccessDecision>> {
    const states = await this.getTeamProviderAccessStates(teamIds, at);
    const result = new Map<string, TeamProviderAccessDecision>();
    for (const [teamId, state] of states) {
      if (state.state === "active" || state.state === "permanent") {
        result.set(teamId, Object.freeze({ kind: "allowed", state: state.state, entitlementId: state.entitlement.id, effectiveEnd: state.entitlement.effectiveEnd }));
      } else {
        result.set(teamId, Object.freeze({
          kind: "denied",
          state: state.state,
          nextEffectiveStart: state.state === "scheduled" ? state.nextEntitlement.effectiveStart : null,
          latestEffectiveEnd: state.latestEffectiveEnd,
        }));
      }
    }
    return result;
  }

  async decidePartnerOperating(teamId: string, at = nowIso()): Promise<PartnerOperatingDecision> {
    return (await this.decidePartnerOperatings([teamId], at)).get(teamId)!;
  }

  async decidePartnerOperatings(teamIds: readonly string[], at = nowIso()): Promise<ReadonlyMap<string, PartnerOperatingDecision>> {
    const ids = [...new Set(teamIds)];
    const result = new Map<string, PartnerOperatingDecision>();
    if (ids.length === 0) return result;
    const rows = await this.client().partner_operating_entitlements.findMany({
      where: { partner_team_id: { in: ids } },
      orderBy: [{ partner_team_id: "asc" }, { effective_end: "desc" }, { created_at: "desc" }, { id: "desc" }],
    });
    const subscriptionIds = [...new Set(rows.map((row) => row.plan_subscription_id))];
    const subscriptions = subscriptionIds.length === 0
      ? []
      : await this.client().plan_subscriptions.findMany({ where: { id: { in: subscriptionIds } } });
    const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    const rowsByTeam = new Map(ids.map((id) => [id, [] as typeof rows]));
    for (const row of rows) rowsByTeam.get(row.partner_team_id)!.push(row);
    for (const id of ids) {
      const teamRows = rowsByTeam.get(id)!;
      if (teamRows.length === 0) {
        result.set(id, Object.freeze({ kind: "denied", state: "not_partner", latestEffectiveEnd: null }));
        continue;
      }
      const current = teamRows.find((row) => {
        if (row.lifecycle !== "active" || row.effective_start > at || row.effective_end <= at) return false;
        const subscription = subscriptionsById.get(row.plan_subscription_id);
        return subscription?.plan_id === row.partner_plan_id
          && subscription.scope_ref === `team:${row.partner_team_id}`
          && subscription.subscription_lifecycle === "active"
          && subscription.effective_start <= at
          && (subscription.effective_end === null || subscription.effective_end > at);
      });
      result.set(id, current
        ? Object.freeze({ kind: "allowed", entitlementId: current.id, subscriptionId: current.plan_subscription_id, effectiveEnd: current.effective_end })
        : Object.freeze({ kind: "denied", state: "inactive", latestEffectiveEnd: teamRows[0]?.effective_end ?? null }));
    }
    return result;
  }

  async decideAccessPointRemovalPlanReferences(accessPointId: string): Promise<Readonly<{ allowed: boolean; enabledPlanId: string | null }>> {
    const relation = await this.client().plan_access_points.findFirst({ where: { access_point_id: accessPointId, plans: { plan_status: { not: "disabled" } } }, select: { plan_id: true }, orderBy: { plan_id: "asc" } });
    return Object.freeze({ allowed: !relation, enabledPlanId: relation?.plan_id ?? null });
  }

  async getTeamProviderEntitlement(entitlementId: string): Promise<TeamProviderEntitlementSnapshot | undefined> {
    const row = await this.client().team_provider_entitlements.findUnique({ where: { id: entitlementId } });
    return row ? teamProviderSnapshot(row) : undefined;
  }

  async getTeamProviderEntitlementForPurchase(purchaseId: string): Promise<TeamProviderEntitlementSnapshot | undefined> {
    const row = await this.client().team_provider_entitlements.findUnique({ where: { source_authority_purchase_id: purchaseId } });
    return row ? teamProviderSnapshot(row) : undefined;
  }

  async cursorTeamProviderEntitlements(teamId: string, cursor?: string, requestedPageSize = 20): Promise<CursorPageResult<TeamProviderEntitlementHistoryRow>> {
    const pageSize = normalizePageSize(requestedPageSize);
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.client().team_provider_entitlements.findMany({
      where: { team_id: teamId, ...(after ? { OR: [{ created_at: { lt: after.createdAt } }, { created_at: after.createdAt, id: { lt: after.id } }] } : {}) },
      orderBy: [{ created_at: "desc" }, { id: "desc" }], take: pageSize + 1,
      include: {
        users_team_provider_entitlements_buyer_user_idTousers: { select: { identity: { select: { email: true } } } },
        users_team_provider_entitlements_issued_by_user_idTousers: { select: { identity: { select: { email: true } } } },
        users_team_provider_entitlements_canceled_by_user_idTousers: { select: { identity: { select: { email: true } } } },
      },
    });
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map((row) => ({ ...teamProviderSnapshot(row), buyerEmail: row.users_team_provider_entitlements_buyer_user_idTousers?.identity?.email ?? null, issuedByEmail: row.users_team_provider_entitlements_issued_by_user_idTousers?.identity?.email ?? null, canceledByEmail: row.users_team_provider_entitlements_canceled_by_user_idTousers?.identity?.email ?? null }));
    const last = items.at(-1);
    return { items, pageSize, hasMore, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async getPersonalProviderEntitlementPeriodForPurchase(purchaseId: string): Promise<PersonalProviderEntitlementPeriodSnapshot | undefined> {
    const row = await this.client().user_provider_entitlement_periods.findUnique({ where: { source_authority_purchase_id: purchaseId } });
    return row ? personalProviderPeriodSnapshot(row) : undefined;
  }

  async currentDatabaseTime(): Promise<string> {
    const rows = await this.client().$queryRaw<Array<{ at: string }>>`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "at"`;
    const at = rows[0]?.at;
    if (!at || !Number.isFinite(Date.parse(at))) throw new RelayError("database_time_unavailable", "Authoritative database time is unavailable", 503);
    return new Date(at).toISOString();
  }

  async getPersonalProviderSlot(slotId: string, at = nowIso()): Promise<PersonalProviderSlotSnapshot | undefined> {
    const row = await this.client().user_provider_slots.findUnique({ where: { id: slotId } });
    if (!row) return undefined;
    return this.personalProviderSlotSnapshot(row, at);
  }

  async getPersonalProviderSlotForProvider(providerId: string, at = nowIso()): Promise<PersonalProviderSlotSnapshot | undefined> {
    const row = await this.client().user_provider_slots.findUnique({ where: { provider_id: providerId } });
    if (!row) return undefined;
    return this.personalProviderSlotSnapshot(row, at);
  }

  async pagePersonalProviderSlotsForUser(userId: string, page = 1, pageSize = 20, at = nowIso()): Promise<{
    items: PersonalProviderSlotSnapshot[]; page: number; pageSize: number; total: number; totalPages: number;
  }> {
    const boundedPageSize = Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 200 ? pageSize : 20;
    const requestedPage = Number.isSafeInteger(page) && page >= 1 ? page : 1;
    const total = await this.client().user_provider_slots.count({ where: { user_id: userId } });
    const totalPages = Math.max(1, Math.ceil(total / boundedPageSize));
    const normalizedPage = Math.min(requestedPage, totalPages);
    const offset = (normalizedPage - 1) * boundedPageSize;
    const rows = await this.client().$queryRaw<Array<{
      id: string; user_id: string; managed_plan_id: string; provider_id: string | null; created_by_authority_purchase_id: string;
      retention_expired_at: string | null; cleanup_status: string; cleanup_error_code: string | null; cleanup_updated_at: string | null;
      created_at: string; latest_effective_end: string; used_access_points: bigint;
    }>>`
      SELECT slot."id", slot."user_id", slot."managed_plan_id", slot."provider_id", slot."created_by_authority_purchase_id",
        slot."retention_expired_at", slot."cleanup_status", slot."cleanup_error_code", slot."cleanup_updated_at", slot."created_at",
        period."effective_end" AS "latest_effective_end", COUNT(ap."id")::bigint AS "used_access_points"
      FROM "user_provider_slots" slot
      JOIN LATERAL (
        SELECT entitlement."effective_end"
        FROM "user_provider_entitlement_periods" entitlement
        WHERE entitlement."provider_slot_id" = slot."id" AND entitlement."lifecycle" = 'active'
        ORDER BY entitlement."effective_end"::timestamptz DESC, entitlement."id" DESC
        LIMIT 1
      ) period ON TRUE
      LEFT JOIN "access_points" ap ON ap."personal_provider_slot_id" = slot."id" AND ap."removed_at" IS NULL
      WHERE slot."user_id" = ${userId}
      GROUP BY slot."id", period."effective_end"
      ORDER BY slot."created_at" ASC, slot."id" ASC
      LIMIT ${boundedPageSize} OFFSET ${offset}`;
    const items = rows.map((row) => {
      const state = personalProviderSlotLifecycle({ at, latestEffectiveEnd: row.latest_effective_end, retentionExpiredAt: row.retention_expired_at });
      return Object.freeze({
        id: row.id, userId: row.user_id, scopeRef: `user:${row.user_id}` as ScopeRef, managedPlanId: row.managed_plan_id,
        providerId: row.provider_id, createdByAuthorityPurchaseId: row.created_by_authority_purchase_id,
        retentionExpiredAt: row.retention_expired_at, cleanupStatus: row.cleanup_status as PersonalProviderSlotSnapshot["cleanupStatus"],
        cleanupErrorCode: row.cleanup_error_code, cleanupUpdatedAt: row.cleanup_updated_at, createdAt: row.created_at,
        latestEffectiveEnd: row.latest_effective_end, renewalCutoff: state.renewalCutoff, lifecycle: state.lifecycle,
        usedAccessPoints: Number(row.used_access_points), maxAccessPoints: PERSONAL_PROVIDER_AP_LIMIT,
      });
    });
    return { items, page: normalizedPage, pageSize: boundedPageSize, total, totalPages };
  }

  async decidePersonalProviderSlotAccess(slotId: string, userId: string, at = nowIso()): Promise<PersonalProviderSlotAccessDecision> {
    const slot = await this.getPersonalProviderSlot(slotId, at);
    if (!slot || slot.userId !== userId) return Object.freeze({ kind: "denied", state: "not_found", slotId: null, latestEffectiveEnd: null, renewalCutoff: null });
    if (slot.lifecycle === "active") return Object.freeze({ kind: "allowed", state: "active", slotId: slot.id, effectiveEnd: slot.latestEffectiveEnd });
    return Object.freeze({ kind: "denied", state: slot.lifecycle, slotId: slot.id, latestEffectiveEnd: slot.latestEffectiveEnd, renewalCutoff: slot.renewalCutoff });
  }

  async decidePersonalProviderAccess(providerId: string, at = nowIso()): Promise<PersonalProviderSlotAccessDecision> {
    return (await this.decidePersonalProviderAccesses([providerId], at)).get(providerId)!;
  }

  async decidePersonalProviderAccesses(providerIds: readonly string[], at = nowIso()): Promise<ReadonlyMap<string, PersonalProviderSlotAccessDecision>> {
    const ids = [...new Set(providerIds)];
    const result = new Map<string, PersonalProviderSlotAccessDecision>();
    if (ids.length === 0) return result;
    const slots = await this.client().user_provider_slots.findMany({ where: { provider_id: { in: ids } } });
    const slotsByProvider = new Map(slots.filter((slot) => slot.provider_id !== null).map((slot) => [slot.provider_id!, slot]));
    const slotIds = slots.map((slot) => slot.id);
    const periods = slotIds.length === 0
      ? []
      : await this.client().user_provider_entitlement_periods.findMany({
        where: { provider_slot_id: { in: slotIds }, lifecycle: "active" },
        orderBy: [{ provider_slot_id: "asc" }, { effective_end: "desc" }, { id: "desc" }],
      });
    const latestPeriodBySlot = new Map<string, (typeof periods)[number]>();
    for (const period of periods) if (!latestPeriodBySlot.has(period.provider_slot_id)) latestPeriodBySlot.set(period.provider_slot_id, period);
    for (const id of ids) {
      const slot = slotsByProvider.get(id);
      const latest = slot ? latestPeriodBySlot.get(slot.id) : undefined;
      if (!slot || !latest) {
        result.set(id, Object.freeze({ kind: "denied", state: "not_found", slotId: null, latestEffectiveEnd: null, renewalCutoff: null }));
        continue;
      }
      const state = personalProviderSlotLifecycle({ at, latestEffectiveEnd: latest.effective_end, retentionExpiredAt: slot.retention_expired_at });
      result.set(id, state.lifecycle === "active"
        ? Object.freeze({ kind: "allowed", state: "active", slotId: slot.id, effectiveEnd: latest.effective_end })
        : Object.freeze({ kind: "denied", state: state.lifecycle, slotId: slot.id, latestEffectiveEnd: latest.effective_end, renewalCutoff: state.renewalCutoff }));
    }
    return result;
  }

  protected async personalProviderSlotSnapshot(row: {
    id: string; user_id: string; managed_plan_id: string; provider_id: string | null; created_by_authority_purchase_id: string;
    retention_expired_at: string | null; cleanup_status: string; cleanup_error_code: string | null; cleanup_updated_at: string | null; created_at: string;
  }, at: string): Promise<PersonalProviderSlotSnapshot> {
    const [latest, usedAccessPoints] = await Promise.all([
      this.client().user_provider_entitlement_periods.findFirst({ where: { provider_slot_id: row.id, lifecycle: "active" }, orderBy: [{ effective_end: "desc" }, { id: "desc" }] }),
      this.client().accessPoint.count({ where: { personalProviderSlotId: row.id, removedAt: null } }),
    ]);
    if (!latest) throw new RelayError("provider_slot_corrupt", "Provider slot entitlement period is missing", 500);
    const state = personalProviderSlotLifecycle({ at, latestEffectiveEnd: latest.effective_end, retentionExpiredAt: row.retention_expired_at });
    return Object.freeze({
      id: row.id, userId: row.user_id, scopeRef: `user:${row.user_id}` as ScopeRef, managedPlanId: row.managed_plan_id,
      providerId: row.provider_id, createdByAuthorityPurchaseId: row.created_by_authority_purchase_id,
      retentionExpiredAt: row.retention_expired_at, cleanupStatus: row.cleanup_status as PersonalProviderSlotSnapshot["cleanupStatus"],
      cleanupErrorCode: row.cleanup_error_code, cleanupUpdatedAt: row.cleanup_updated_at, createdAt: row.created_at,
      latestEffectiveEnd: latest.effective_end, renewalCutoff: state.renewalCutoff, lifecycle: state.lifecycle,
      usedAccessPoints, maxAccessPoints: PERSONAL_PROVIDER_AP_LIMIT,
    });
  }
}

/** Entitlement-owned named Commands. No generic patch/delete entry is exposed. */
export class EntitlementCommands extends EntitlementInfrastructure implements EntitlementContextCommands {
  private readonly queries: EntitlementQueries;

  constructor(root: RootEntitlementClient, transaction?: EntitlementClient, private readonly auditAppender: AuditEventAppender = new PrismaAuditEventAppender()) {
    super(root, transaction);
    this.queries = new EntitlementQueries(root, transaction);
  }

  private run<T>(callback: (commands: EntitlementCommands) => Promise<T>, maxAttempts = 3, isolationLevel: "ReadCommitted" | "Serializable" = "ReadCommitted"): Promise<T> {
    if (this.transaction) return callback(this);
    return this.root.withPrismaTransaction(
      (transaction) => callback(new EntitlementCommands(this.root, transaction, this.auditAppender)),
      maxAttempts,
      { isolationLevel },
    );
  }

  async createPlanDefinition(command: CreatePlanDefinitionCommand): Promise<PlanDefinitionSnapshot> {
    return this.run(async (commands) => {
      const normalized = await commands.validatePlanDefinition(command);
      const versionRows = await commands.client().$queryRaw<Array<{ version: number }>>`SELECT COALESCE(MAX("version"), 0)::int + 1 AS "version" FROM "plans" WHERE "name" = ${normalized.name}`;
      const version = versionRows[0]?.version ?? 1;
      const at = nowIso();
      const plan = await commands.client().plans.create({ data: {
        id: command.id ?? createId("plan"), owner_id: command.ownerId, scope_ref: command.scopeRef, name: normalized.name, version,
        description: command.description, admin_note: command.adminNote,
        billing_mode: command.financialTerms.billingMode, purchase_amount: command.financialTerms.purchaseAmount,
        purchase_amount_units: command.financialTerms.purchaseAmountUnits, duration_seconds: normalized.durationSeconds,
        plan_status: normalized.status, catalog_status: normalized.status === "enabled" ? normalized.catalogStatus : "unlisted", created_at: at, updated_at: at,
      } });
      await commands.replacePlanAccessPoints(plan.id, command.accessPointIds, at);
      await commands.replacePlanBudgetLimits(plan.id, command.budgetLimits, at);
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: command.actorUserId }, action: "plan.create", resourceType: "plan", resourceId: plan.id, result: "success", source: "owner", requestId: command.requestId ?? null, metadata: { ownerId: plan.owner_id, scopeRef: plan.scope_ref, version: plan.version, status: plan.plan_status, accessPointCount: new Set(command.accessPointIds).size, budgetLimitCount: normalizeBudgetLimits(command.budgetLimits).length } });
      return planSnapshot(plan);
    }, 3, "Serializable");
  }

  async revisePlanDefinition(planId: string, command: RevisePlanDefinitionCommand): Promise<PlanDefinitionSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "plans" WHERE "id" = ${planId} FOR UPDATE`;
      const existing = await commands.client().plans.findUnique({ where: { id: planId } });
      if (!existing) throw new RelayError("plan_template_not_found", `Plan template ${planId} not found`, 404);
      const currentAccess = await commands.queries.listPlanAccessPoints(planId);
      const currentLimits = (await commands.queries.listPlanBudgetLimitsForPlans([planId])).get(planId) ?? [];
      const nextAccess = command.accessPointIds ?? currentAccess.map((row) => row.accessPointId);
      const nextLimits = command.budgetLimits ?? currentLimits;
      const nextFinancial = command.financialTerms ?? { billingMode: existing.billing_mode as "prepaid" | "paygo", purchaseAmount: existing.purchase_amount, purchaseAmountUnits: existing.purchase_amount_units };
      const normalized = await commands.validatePlanDefinition({
        ownerId: command.ownerId ?? existing.owner_id, scopeRef: command.scopeRef ?? existing.scope_ref as ScopeRef,
        name: command.name ?? existing.name, description: command.description ?? existing.description, adminNote: command.adminNote ?? existing.admin_note,
        durationSeconds: command.durationSeconds ?? existing.duration_seconds, status: command.status ?? existing.plan_status as "enabled" | "closed" | "disabled",
        catalogStatus: command.catalogStatus ?? existing.catalog_status as "listed" | "unlisted", accessPointIds: nextAccess,
        budgetLimits: nextLimits, financialTerms: nextFinancial, actorUserId: command.actorUserId,
      });
      const commercialChanged = normalized.durationSeconds !== existing.duration_seconds
        || nextFinancial.billingMode !== existing.billing_mode || nextFinancial.purchaseAmountUnits !== existing.purchase_amount_units
        || !sameAccessPoints(currentAccess.map((row) => row.accessPointId), nextAccess)
        || !sameBudgetLimits(currentLimits, nextLimits);
      if (command.hasHistoricalReferences && commercialChanged) throw new RelayError("sold_plan_terms_immutable", "Sold Plan commercial terms require a new Plan version", 409);
      if (existing.plan_status === "enabled" && normalized.status === "disabled") throw new RelayError("plan_must_be_closed_first", "Enabled Plan must be closed before it can be disabled", 409);
      if (existing.plan_status === "disabled" && normalized.status === "closed") throw new RelayError("invalid_plan_status_transition", "Disabled Plan must be enabled before it can be closed", 409);
      if (existing.plan_status === "closed" && normalized.status === "disabled" && command.hasOutstandingEntitlements) throw new RelayError("sold_plan_in_use", "Plan with available Cards or active/future Subscriptions cannot be disabled", 409);
      const updated = await commands.client().plans.update({ where: { id: planId }, data: {
        owner_id: command.ownerId ?? existing.owner_id, scope_ref: command.scopeRef ?? existing.scope_ref,
        name: normalized.name, description: command.description === undefined ? existing.description : command.description,
        admin_note: command.adminNote === undefined ? existing.admin_note : command.adminNote,
        billing_mode: nextFinancial.billingMode, purchase_amount: nextFinancial.purchaseAmount, purchase_amount_units: nextFinancial.purchaseAmountUnits,
        duration_seconds: normalized.durationSeconds, plan_status: normalized.status,
        catalog_status: normalized.status === "enabled" ? normalized.catalogStatus : "unlisted", updated_at: nowIso(),
      } });
      if (command.accessPointIds !== undefined) await commands.replacePlanAccessPoints(planId, nextAccess, updated.updated_at);
      if (command.budgetLimits !== undefined) await commands.replacePlanBudgetLimits(planId, nextLimits, updated.updated_at);
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: command.actorUserId }, action: "plan.update", resourceType: "plan", resourceId: planId, result: "success", source: "owner", requestId: command.requestId ?? null, metadata: { ownerId: updated.owner_id, scopeRef: updated.scope_ref, version: updated.version, oldStatus: existing.plan_status, newStatus: updated.plan_status, oldCatalogStatus: existing.catalog_status, newCatalogStatus: updated.catalog_status } });
      return planSnapshot(updated);
    }, 3, "Serializable");
  }

  async retireUnreferencedPlan(planId: string, input: { hasHistoricalReferences: boolean; actorUserId: string; requestId?: string | null }): Promise<{ retired: boolean }> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "plans" WHERE "id" = ${planId} FOR UPDATE`;
      const plan = await commands.client().plans.findUnique({ where: { id: planId } });
      if (!plan) return { retired: false };
      if (input.hasHistoricalReferences) throw new RelayError("plan_has_historical_references", "Referenced Plan facts cannot be physically deleted", 409);
      await commands.client().plan_access_points.deleteMany({ where: { plan_id: planId } });
      await commands.client().plan_budget_limits.deleteMany({ where: { plan_id: planId } });
      await commands.client().plans.delete({ where: { id: planId } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorUserId }, action: "plan.delete", resourceType: "plan", resourceId: planId, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { id: planId } });
      return { retired: true };
    }, 3, "Serializable");
  }

  async createSubscription(command: CreatePlanSubscriptionCommand): Promise<PlanSubscriptionSnapshot> {
    return this.run((commands) => commands.createSubscriptionInTransaction(command), 3, "Serializable");
  }

  async createSubscriptionInTransaction(command: CreatePlanSubscriptionCommand): Promise<PlanSubscriptionSnapshot> {
    const plan = await this.client().plans.findUnique({ where: { id: command.planId } });
    if (!plan) throw new RelayError("plan_not_found", `Plan ${command.planId} not found`, 404);
    if (plan.plan_status !== "enabled" && !(command.allowClosedPlan && plan.plan_status === "closed")) throw new RelayError("plan_not_open_for_new_entitlements", "Plan does not accept new entitlements", 409);
    requireSubscriptionScope(command.scopeRef);
    const effectiveStart = command.effectiveStart ?? nowIso();
    const effectiveEnd = command.effectiveEnd === undefined ? addSeconds(effectiveStart, plan.duration_seconds) : command.effectiveEnd;
    requireInterval(effectiveStart, effectiveEnd);
    await this.lockPlanSource(command.planId, command.scopeRef);
    await this.assertNoSubscriptionOverlap(command.planId, command.scopeRef, effectiveStart, effectiveEnd);
    const at = nowIso();
    const row = await this.client().plan_subscriptions.create({ data: {
      id: command.id ?? createId("plan_sub"), plan_id: command.planId, source: requiredText(command.source, "source", 100), scope_ref: command.scopeRef,
      purchased_by_user_id: command.purchasedByUserId ?? null, funding_account_id: command.fundingAccountId ?? null, origin_card_id: command.originCardId ?? null,
      priority: boundedInteger(command.priority ?? 100, "priority"), effective_start: effectiveStart, effective_end: effectiveEnd,
      subscription_lifecycle: "active", created_at: at, updated_at: at,
    } });
    await this.auditAppender.append(this.client(), { actor: command.actor, action: "plan_subscription.create", resourceType: "plan_subscription", resourceId: row.id, result: "success", source: command.auditSource, requestId: command.requestId ?? null, metadata: { scopeRef: row.scope_ref, planId: row.plan_id, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, priority: row.priority, source: row.source } });
    return subscriptionSnapshot(row);
  }

  async createSubscriptionUnits(command: Omit<CreatePlanSubscriptionCommand, "effectiveEnd"> & { units: number }): Promise<PlanSubscriptionSnapshot[]> {
    return this.run(async (commands) => {
      if (!Number.isSafeInteger(command.units) || command.units < 1 || command.units > 1_000) throw new RelayError("invalid_plan_units", "Plan subscription units must be a positive integer", 400);
      const plan = await commands.client().plans.findUnique({ where: { id: command.planId } });
      if (!plan || plan.duration_seconds <= 0) throw new RelayError("invalid_plan_duration", "Plan duration must be greater than 0", 409);
      let start = command.effectiveStart ?? nowIso();
      const result: PlanSubscriptionSnapshot[] = [];
      for (let unit = 0; unit < command.units; unit += 1) {
        const end = addSeconds(start, plan.duration_seconds);
        result.push(await commands.createSubscriptionInTransaction({ ...command, effectiveStart: start, effectiveEnd: end }));
        start = end;
      }
      return result;
    }, 3, "Serializable");
  }

  async createPurchasedPersonalProviderSlotFulfillment(input: {
    purchaseId: string; productId: string; productCode: string; productVersion: number; productDisplayName: string;
    buyerUserId: string; durationSeconds: number; purchaseAmountUnits: bigint; fulfilledAt: string; requestId?: string | null;
  }): Promise<{ slot: PersonalProviderSlotSnapshot; period: PersonalProviderEntitlementPeriodSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const existing = await commands.queries.getPersonalProviderEntitlementPeriodForPurchase(input.purchaseId);
      if (existing) {
        const slot = await commands.queries.getPersonalProviderSlot(existing.providerSlotId, input.fulfilledAt);
        if (!slot) throw new RelayError("authority_purchase_corrupt", "Personal Provider slot is missing", 500);
        return { slot, period: existing, replayed: true };
      }
      const durationDays = durationDaysFromSeconds(input.durationSeconds);
      const slotId = createId("provider_slot");
      const planId = createId("plan");
      const subscriptionId = createId("plan_sub");
      const effectiveStart = input.fulfilledAt;
      const effectiveEnd = addSeconds(effectiveStart, durationDays * SECONDS_PER_DAY);
      await commands.createPlanDefinition({
        id: planId, ownerId: input.buyerUserId, scopeRef: `user:${input.buyerUserId}`,
        name: `Personal Provider Slot ${slotId}`, description: "System-managed personal Provider access", adminNote: "system-managed:personal-provider-slot",
        durationSeconds: input.durationSeconds, status: "enabled", catalogStatus: "unlisted", accessPointIds: [], budgetLimits: [],
        financialTerms: { billingMode: "prepaid", purchaseAmount: 0, purchaseAmountUnits: 0n },
        actorUserId: input.buyerUserId, requestId: input.requestId ?? null,
      });
      await commands.client().user_provider_slots.create({ data: {
        id: slotId, user_id: input.buyerUserId, managed_plan_id: planId, provider_id: null,
        created_by_authority_purchase_id: input.purchaseId, retention_expired_at: null, cleanup_status: "not_due",
        cleanup_error_code: null, cleanup_updated_at: null, created_at: input.fulfilledAt,
      } });
      const subscription = await commands.createSubscriptionInTransaction({
        id: subscriptionId, planId, scopeRef: `user:${input.buyerUserId}`, source: "personal_provider_slot",
        purchasedByUserId: input.buyerUserId, priority: 10, effectiveStart, effectiveEnd,
        actor: { actorType: "user", actorId: input.buyerUserId }, auditSource: "web", requestId: input.requestId ?? null,
      });
      const row = await commands.client().user_provider_entitlement_periods.create({ data: {
        id: createId("provider_entitlement"), provider_slot_id: slotId, user_id: input.buyerUserId,
        source_authority_purchase_id: input.purchaseId, source_authority_product_id: input.productId,
        source_product_code_snapshot: input.productCode, source_product_version_snapshot: input.productVersion,
        source_product_display_name_snapshot: input.productDisplayName, purchase_amount_units_snapshot: input.purchaseAmountUnits,
        duration_days_snapshot: durationDays, renewal_admitted_at: input.fulfilledAt, fulfillment_succeeded_at: input.fulfilledAt,
        effective_start: effectiveStart, effective_end: effectiveEnd, plan_subscription_id: subscription.id,
        lifecycle: "active", created_at: input.fulfilledAt,
      } });
      await commands.auditAppender.append(commands.client(), {
        actor: { actorType: "user", actorId: input.buyerUserId }, action: "personal_provider_slot.purchase",
        resourceType: "personal_provider_slot", resourceId: slotId, result: "success", source: "web", requestId: input.requestId ?? null,
        metadata: { productId: input.productId, productVersion: input.productVersion, periodId: row.id, effectiveStart, effectiveEnd, durationDays },
      });
      const slot = await commands.queries.getPersonalProviderSlot(slotId, input.fulfilledAt);
      if (!slot) throw new RelayError("provider_slot_corrupt", "Personal Provider slot fulfillment failed", 500);
      return { slot, period: personalProviderPeriodSnapshot(row), replayed: false };
    }, 3, "Serializable");
  }

  async lockPersonalProviderSlotForRenewal(slotId: string, userId: string, admittedAt: string): Promise<PersonalProviderSlotSnapshot> {
    await this.client().$queryRaw`SELECT "id" FROM "user_provider_slots" WHERE "id" = ${slotId} FOR UPDATE`;
    const slot = await this.queries.getPersonalProviderSlot(slotId, admittedAt);
    if (!slot || slot.userId !== userId) throw new RelayError("provider_slot_not_found", "Personal Provider slot not found", 404);
    if (slot.lifecycle === "retention_expired") throw new RelayError("provider_slot_renewal_window_expired", "The Provider slot renewal window has expired", 409);
    return slot;
  }

  async renewPurchasedPersonalProviderSlotFulfillment(input: {
    slotId: string; purchaseId: string; productId: string; productCode: string; productVersion: number; productDisplayName: string;
    buyerUserId: string; durationSeconds: number; purchaseAmountUnits: bigint; renewalAdmittedAt: string; fulfilledAt: string; requestId?: string | null;
  }): Promise<{ slot: PersonalProviderSlotSnapshot; period: PersonalProviderEntitlementPeriodSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const existing = await commands.queries.getPersonalProviderEntitlementPeriodForPurchase(input.purchaseId);
      if (existing) {
        if (existing.providerSlotId !== input.slotId) throw new RelayError("authority_idempotency_conflict", "Renewal Purchase targets another Provider slot", 409);
        const slot = await commands.queries.getPersonalProviderSlot(input.slotId, input.fulfilledAt);
        if (!slot) throw new RelayError("authority_purchase_corrupt", "Personal Provider slot is missing", 500);
        return { slot, period: existing, replayed: true };
      }
      const slot = await commands.lockPersonalProviderSlotForRenewal(input.slotId, input.buyerUserId, input.renewalAdmittedAt);
      const window = personalProviderRenewalWindow({
        latestEffectiveEnd: slot.latestEffectiveEnd, fulfillmentSucceededAt: input.fulfilledAt,
        renewalAdmittedAt: input.renewalAdmittedAt, durationDays: durationDaysFromSeconds(input.durationSeconds),
      });
      const subscription = await commands.createSubscriptionInTransaction({
        id: createId("plan_sub"), planId: slot.managedPlanId, scopeRef: slot.scopeRef, source: "personal_provider_slot_renewal",
        purchasedByUserId: input.buyerUserId, priority: 10, effectiveStart: window.effectiveStart, effectiveEnd: window.effectiveEnd,
        actor: { actorType: "user", actorId: input.buyerUserId }, auditSource: "web", requestId: input.requestId ?? null,
      });
      const row = await commands.client().user_provider_entitlement_periods.create({ data: {
        id: createId("provider_entitlement"), provider_slot_id: slot.id, user_id: slot.userId,
        source_authority_purchase_id: input.purchaseId, source_authority_product_id: input.productId,
        source_product_code_snapshot: input.productCode, source_product_version_snapshot: input.productVersion,
        source_product_display_name_snapshot: input.productDisplayName, purchase_amount_units_snapshot: input.purchaseAmountUnits,
        duration_days_snapshot: window.durationDays, renewal_admitted_at: input.renewalAdmittedAt, fulfillment_succeeded_at: input.fulfilledAt,
        effective_start: window.effectiveStart, effective_end: window.effectiveEnd, plan_subscription_id: subscription.id,
        lifecycle: "active", created_at: input.fulfilledAt,
      } });
      await commands.auditAppender.append(commands.client(), {
        actor: { actorType: "user", actorId: input.buyerUserId }, action: "personal_provider_slot.renew",
        resourceType: "personal_provider_slot", resourceId: slot.id, result: "success", source: "web", requestId: input.requestId ?? null,
        metadata: { productId: input.productId, productVersion: input.productVersion, periodId: row.id, effectiveStart: window.effectiveStart, effectiveEnd: window.effectiveEnd, durationDays: window.durationDays },
      });
      const renewed = await commands.queries.getPersonalProviderSlot(slot.id, input.fulfilledAt);
      if (!renewed) throw new RelayError("provider_slot_corrupt", "Personal Provider slot renewal failed", 500);
      return { slot: renewed, period: personalProviderPeriodSnapshot(row), replayed: false };
    }, 3, "Serializable");
  }

  async requireActivePersonalProviderSlot(slotId: string, userId: string, at?: string): Promise<PersonalProviderSlotSnapshot> {
    const effectiveAt = at ?? await this.queries.currentDatabaseTime();
    await this.client().$queryRaw`SELECT "id" FROM "user_provider_slots" WHERE "id" = ${slotId} FOR UPDATE`;
    const slot = await this.queries.getPersonalProviderSlot(slotId, effectiveAt);
    if (!slot || slot.userId !== userId) throw new RelayError("provider_slot_not_found", "Personal Provider slot not found", 404);
    if (slot.lifecycle !== "active") throw new RelayError("provider_slot_inactive", "An active personal Provider slot is required", 403, { state: slot.lifecycle });
    return slot;
  }

  async includePersonalAccessPointInManagedPlan(input: { slotId: string; accessPointId: string; at?: string }): Promise<void> {
    await this.run(async (commands) => {
      const slot = await commands.client().user_provider_slots.findUnique({ where: { id: input.slotId } });
      const accessPoint = await commands.client().accessPoint.findUnique({ where: { id: input.accessPointId } });
      if (!slot || !accessPoint || accessPoint.personalProviderSlotId !== slot.id || accessPoint.removedAt) {
        throw new RelayError("personal_access_point_slot_mismatch", "AccessPoint does not belong to the selected personal Provider slot", 409);
      }
      await commands.client().plan_access_points.upsert({
        where: { plan_id_access_point_id: { plan_id: slot.managed_plan_id, access_point_id: accessPoint.id } },
        create: { id: createId("plan_ap"), plan_id: slot.managed_plan_id, access_point_id: accessPoint.id, created_at: input.at ?? nowIso() },
        update: {},
      });
    }, 3, "Serializable");
  }

  async detachPersonalAccessPointFromManagedPlan(input: { slotId: string; accessPointId: string }): Promise<void> {
    await this.run(async (commands) => {
      const slot = await commands.client().user_provider_slots.findUnique({ where: { id: input.slotId } });
      const accessPoint = await commands.client().accessPoint.findUnique({ where: { id: input.accessPointId } });
      if (!slot || !accessPoint || accessPoint.personalProviderSlotId !== slot.id) throw new RelayError("personal_access_point_slot_mismatch", "AccessPoint does not belong to the selected personal Provider slot", 409);
      await commands.client().plan_access_points.deleteMany({ where: { plan_id: slot.managed_plan_id, access_point_id: accessPoint.id } });
    }, 3, "Serializable");
  }

  async bindPersonalProviderToSlot(input: { slotId: string; userId: string; providerId: string; at?: string }): Promise<PersonalProviderSlotSnapshot> {
    return this.run(async (commands) => {
      const slot = await commands.requireActivePersonalProviderSlot(input.slotId, input.userId, input.at ?? nowIso());
      if (slot.providerId && slot.providerId !== input.providerId) throw new RelayError("provider_slot_occupied", "Personal Provider slot already has a Provider", 409);
      const provider = await commands.client().providers.findUnique({ where: { id: input.providerId }, include: { provider_bindings: true } });
      if (!provider || provider.owner_id !== input.userId || provider.scope_ref !== `user:${input.userId}` || provider.kind !== "codex"
        || provider.base_url_resolver !== "literal:" || provider.credential_resolver !== "oauth:"
        || provider.models_resolver !== "cliproxyapi:catalog" || provider.config_json !== "{}" || provider.cpa_instance_id !== "cpa_default"
        || provider.provider_bindings?.auth_method !== "oauth" || provider.provider_bindings.credential_ownership !== "cpa-managed") {
        throw new RelayError("personal_provider_definition_invalid", "Personal Provider must use server-managed Codex OAuth", 409);
      }
      if (!slot.providerId) await commands.client().user_provider_slots.update({ where: { id: slot.id }, data: { provider_id: provider.id } });
      return (await commands.queries.getPersonalProviderSlot(slot.id, input.at ?? nowIso()))!;
    }, 3, "Serializable");
  }

  async finalizePersonalProviderSlotRetention(input: { slotId: string; at?: string; initiatedBy?: string | null; requestId?: string | null }): Promise<{ slot: PersonalProviderSlotSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const at = input.at ?? await commands.queries.currentDatabaseTime();
      await commands.client().$queryRaw`SELECT "id" FROM "user_provider_slots" WHERE "id" = ${input.slotId} FOR UPDATE`;
      const current = await commands.queries.getPersonalProviderSlot(input.slotId, at);
      if (!current) throw new RelayError("provider_slot_not_found", "Personal Provider slot not found", 404);
      if (current.retentionExpiredAt) return { slot: current, replayed: true };
      if (current.lifecycle !== "retention_expired") throw new RelayError("provider_slot_retention_not_due", "Personal Provider slot retention is not due", 409);
      await commands.client().user_provider_slots.update({ where: { id: current.id }, data: {
        retention_expired_at: at, cleanup_status: "pending", cleanup_error_code: null, cleanup_updated_at: at,
      } });
      await commands.auditAppender.append(commands.client(), {
        actor: { actorType: "system", actorId: "personal-provider-retention" }, action: "personal_provider_slot.retention_finalize",
        resourceType: "personal_provider_slot", resourceId: current.id, result: "success", source: "system", requestId: input.requestId ?? null,
        metadata: { renewalCutoff: current.renewalCutoff, initiatedBy: input.initiatedBy ?? null, cleanupStatus: "pending" },
      });
      return { slot: (await commands.queries.getPersonalProviderSlot(current.id, at))!, replayed: false };
    }, 3, "Serializable");
  }

  async replaceApiKeyPlanSourceRestriction(input: {
    apiKeyId: string;
    ownerUserId: string;
    mode: "all" | "restricted";
    sourceKeys: readonly import("./index.js").PlanSourceKey[];
    teamScopeRefs: readonly ScopeRef[];
    actor: { actorType: "user"; actorId: string };
    auditSource: "web" | "owner";
    requestId?: string | null;
  }): Promise<ApiKeyPlanSourceRestrictionDecision> {
    return this.run(async (commands) => {
      const apiKey = (await commands.client().$queryRaw<Array<{ id: string; userId: string }>>`
        SELECT "id", "user_id" AS "userId"
        FROM "api_keys"
        WHERE "id" = ${input.apiKeyId}
        FOR UPDATE
      `)[0];
      if (!apiKey) throw new RelayError("api_key_not_found", "API key not found", 404);
      if (apiKey.userId !== input.ownerUserId) throw new RelayError("api_key_owner_mismatch", "API key owner does not match the authenticated owner", 403);

      const sourceKeys = input.mode === "restricted" ? normalizeApiKeySourceKeys(input.sourceKeys) : [];
      const teamScopeRefs = input.mode === "restricted" ? normalizeApiKeyTeamScopeRefs(input.teamScopeRefs) : [];
      if (input.mode === "restricted") {
        const [existingSources, existingTeams] = await Promise.all([
          commands.client().$queryRaw<Array<{ planId: string; scopeRef: string }>>`
            SELECT "plan_id" AS "planId", "subscription_scope_ref" AS "scopeRef"
            FROM "api_key_plan_source_selections"
            WHERE "api_key_id" = ${input.apiKeyId}
          `,
          commands.client().$queryRaw<Array<{ teamId: string }>>`
            SELECT "team_id" AS "teamId"
            FROM "api_key_team_scope_selections"
            WHERE "api_key_id" = ${input.apiKeyId}
          `,
        ]);
        await commands.assertCurrentApiKeyPlanSourceSelections(
          input.ownerUserId,
          sourceKeys,
          teamScopeRefs,
          nowIso(),
          existingSources.map((source) => ({ planId: source.planId, subscriptionScopeRef: source.scopeRef as ScopeRef })),
          existingTeams.map((team) => `team:${team.teamId}` as ScopeRef),
        );
      }

      await commands.client().$queryRaw`DELETE FROM "api_key_plan_source_selections" WHERE "api_key_id" = ${input.apiKeyId}`;
      await commands.client().$queryRaw`DELETE FROM "api_key_team_scope_selections" WHERE "api_key_id" = ${input.apiKeyId}`;
      await commands.client().$queryRaw`DELETE FROM "api_key_plan_source_restrictions" WHERE "api_key_id" = ${input.apiKeyId}`;
      if (input.mode === "restricted") {
        const at = nowIso();
        await commands.client().$queryRaw`
          INSERT INTO "api_key_plan_source_restrictions" ("api_key_id", "mode", "created_at", "updated_at")
          VALUES (${input.apiKeyId}, 'restricted', ${at}, ${at})
        `;
        if (sourceKeys.length > 0) {
          await commands.client().$queryRaw(Prisma.sql`
            INSERT INTO "api_key_plan_source_selections" ("id", "api_key_id", "plan_id", "subscription_scope_ref", "created_at")
            VALUES ${Prisma.join(sourceKeys.map((source) => Prisma.sql`(${createId("api_key_source")}, ${input.apiKeyId}, ${source.planId}, ${source.subscriptionScopeRef}, ${at})`))}
          `);
        }
        if (teamScopeRefs.length > 0) {
          await commands.client().$queryRaw(Prisma.sql`
            INSERT INTO "api_key_team_scope_selections" ("id", "api_key_id", "team_id", "created_at")
            VALUES ${Prisma.join(teamScopeRefs.map((scopeRef) => Prisma.sql`(${createId("api_key_team_scope")}, ${input.apiKeyId}, ${parseScopeRef(scopeRef).scopeId}, ${at})`))}
          `);
        }
      }

      const decision = await commands.queries.decideApiKeyPlanSourceRestriction(input.apiKeyId);
      await commands.auditAppender.append(commands.client(), {
        actor: input.actor,
        action: "api_key.plan_source_restriction.replace",
        resourceType: "api_key",
        resourceId: input.apiKeyId,
        result: "success",
        source: input.auditSource,
        requestId: input.requestId ?? null,
        metadata: { mode: decision.mode, sourceCount: sourceKeys.length, teamCount: teamScopeRefs.length },
      });
      return decision;
    }, 3, "Serializable");
  }

  private async assertCurrentApiKeyPlanSourceSelections(
    ownerUserId: string,
    sourceKeys: readonly import("./index.js").PlanSourceKey[],
    teamScopeRefs: readonly ScopeRef[],
    at: string,
    existingSourceKeys: readonly import("./index.js").PlanSourceKey[],
    existingTeamScopeRefs: readonly ScopeRef[],
  ): Promise<void> {
    if (sourceKeys.length === 0 && teamScopeRefs.length === 0) return;
    const sourceConditions = [
      ...sourceKeys.map((source) => Prisma.sql`(subscription."plan_id" = ${source.planId} AND subscription."scope_ref" = ${source.subscriptionScopeRef})`),
      ...teamScopeRefs.map((scopeRef) => Prisma.sql`subscription."scope_ref" = ${scopeRef}`),
    ];
    const rows = await this.client().$queryRaw<Array<{ planId: string; scopeRef: string }>>(Prisma.sql`
      WITH scopes AS (
        SELECT 'global:'::text AS "scopeRef"
        UNION ALL SELECT 'user:' || ${ownerUserId}
        UNION ALL
        SELECT 'team:' || membership."team_id"
        FROM "team_memberships" membership
        INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
        WHERE membership."user_id" = ${ownerUserId}
          AND NOT EXISTS (
            SELECT 1 FROM "team_deletion_lifecycles" deletion
            WHERE deletion."team_id" = membership."team_id"
              AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
          )
      ), candidates AS (
        SELECT subscription."plan_id" AS "planId", subscription."scope_ref" AS "scopeRef"
        FROM scopes
        INNER JOIN "plan_subscriptions" subscription
          ON subscription."scope_ref" = scopes."scopeRef"
          AND subscription."subscription_lifecycle" = 'active'
          AND subscription."effective_start" <= ${at}
          AND (subscription."effective_end" IS NULL OR subscription."effective_end" > ${at})
        INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
        INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
        INNER JOIN "access_points" access_point
          ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
        WHERE ${Prisma.join(sourceConditions, " OR ")}
        GROUP BY subscription."plan_id", subscription."scope_ref"
      )
      SELECT "planId", "scopeRef" FROM candidates
    `);
    const exactSet = new Set(rows.map((row) => `${row.planId}\u0000${row.scopeRef}`));
    const existingExactSet = new Set(existingSourceKeys.map((source) => `${source.planId}\u0000${source.subscriptionScopeRef}`));
    for (const source of sourceKeys) {
      if (!exactSet.has(`${source.planId}\u0000${source.subscriptionScopeRef}`) && !existingExactSet.has(`${source.planId}\u0000${source.subscriptionScopeRef}`)) {
        throw new RelayError("api_key_plan_source_unavailable", "One or more selected Plan sources are not currently available to the API key owner", 409);
      }
    }
    const existingTeamSet = new Set(existingTeamScopeRefs);
    for (const scopeRef of teamScopeRefs) {
      if (!rows.some((row) => row.scopeRef === scopeRef) && !existingTeamSet.has(scopeRef)) {
        throw new RelayError("api_key_team_scope_unavailable", "One or more selected Team scopes are not currently available to the API key owner", 409);
      }
    }
  }

  async cancelSubscription(subscriptionId: string, input: { actorUserId: string; effectiveEnd?: string; requestId?: string | null }): Promise<PlanSubscriptionSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "plan_subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`;
      const row = await commands.client().plan_subscriptions.findUnique({ where: { id: subscriptionId } });
      if (!row) throw new RelayError("plan_subscription_not_found", `Plan subscription ${subscriptionId} not found`, 404);
      if (row.subscription_lifecycle === "canceled") return subscriptionSnapshot(row);
      const effectiveEnd = input.effectiveEnd ?? nowIso();
      if (row.subscription_lifecycle !== "active" || (row.effective_end !== null && row.effective_end <= effectiveEnd)) throw new RelayError("plan_subscription_not_cancelable", "Only current or future active Plan subscriptions can be canceled", 409);
      const nextEnd = row.effective_end && row.effective_end < effectiveEnd ? row.effective_end : effectiveEnd;
      const updated = await commands.client().plan_subscriptions.update({ where: { id: subscriptionId }, data: { subscription_lifecycle: "canceled", effective_end: nextEnd, updated_at: nowIso() } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorUserId }, action: "plan_subscription.cancel", resourceType: "plan_subscription", resourceId: subscriptionId, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { scopeRef: updated.scope_ref, planId: updated.plan_id, effectiveEnd: updated.effective_end, lifecycle: updated.subscription_lifecycle } });
      return subscriptionSnapshot(updated);
    }, 3, "Serializable");
  }

  /** Named compatibility Command for the existing PATCH route. It preserves the
   * route while preventing a generic persistence patch API from escaping. */
  async reviseSubscriptionCompatibility(subscriptionId: string, command: ReviseSubscriptionCompatibilityCommand): Promise<PlanSubscriptionSnapshot> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "plan_subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`;
      const existing = await commands.client().plan_subscriptions.findUnique({ where: { id: subscriptionId } });
      if (!existing) throw new RelayError("plan_subscription_not_found", `Plan subscription ${subscriptionId} not found`, 404);
      if (existing.origin_card_id && command.planId !== undefined && command.planId !== existing.plan_id) throw new RelayError("origin_card_subscription_immutable", "Card-origin Subscription Plan cannot be changed", 409);
      const planId = command.planId ?? existing.plan_id;
      const scopeRef = command.scopeRef ?? existing.scope_ref as ScopeRef;
      requireSubscriptionScope(scopeRef);
      const plan = await commands.client().plans.findUnique({ where: { id: planId } });
      if (!plan) throw new RelayError("plan_not_found", `Plan ${planId} not found`, 404);
      const changesEntitlement = (command.planId !== undefined && command.planId !== existing.plan_id)
        || (command.scopeRef !== undefined && command.scopeRef !== existing.scope_ref)
        || (command.effectiveStart !== undefined && command.effectiveStart !== existing.effective_start)
        || (command.effectiveEnd !== undefined && command.effectiveEnd !== existing.effective_end)
        || (command.subscriptionLifecycle !== undefined && command.subscriptionLifecycle !== existing.subscription_lifecycle);
      if (changesEntitlement && plan.plan_status !== "enabled") throw new RelayError("plan_not_open_for_entitlement_changes", "Closed or disabled Plan entitlements cannot be extended or reassigned", 409);
      const effectiveStart = command.effectiveStart ?? existing.effective_start;
      const effectiveEnd = command.effectiveEnd === undefined ? existing.effective_end : command.effectiveEnd;
      requireInterval(effectiveStart, effectiveEnd);
      const lifecycle = command.subscriptionLifecycle ?? existing.subscription_lifecycle as "active" | "canceled";
      if (lifecycle === "active") {
        await commands.lockPlanSource(planId, scopeRef);
        await commands.assertNoSubscriptionOverlap(planId, scopeRef, effectiveStart, effectiveEnd, subscriptionId);
      }
      const data = {
        plan_id: planId, source: command.source ?? existing.source, scope_ref: scopeRef,
        purchased_by_user_id: command.purchasedByUserId === undefined ? existing.purchased_by_user_id : command.purchasedByUserId,
        funding_account_id: command.fundingAccountId === undefined ? existing.funding_account_id : command.fundingAccountId,
        priority: command.priority ?? existing.priority, effective_start: effectiveStart, effective_end: effectiveEnd,
        subscription_lifecycle: lifecycle, updated_at: nowIso(),
      };
      const updated = await commands.client().plan_subscriptions.update({ where: { id: subscriptionId }, data });
      const changedFields = Object.entries(data).filter(([key, value]) => key !== "updated_at" && value !== existing[key as keyof typeof existing]).map(([key]) => key).sort();
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: command.actorUserId }, action: "plan_subscription.update", resourceType: "plan_subscription", resourceId: subscriptionId, result: "success", source: "owner", requestId: command.requestId ?? null, metadata: { scopeRef: updated.scope_ref, planId: updated.plan_id, effectiveEnd: updated.effective_end, priority: updated.priority, lifecycle: updated.subscription_lifecycle, changedFields } });
      return subscriptionSnapshot(updated);
    }, 3, "Serializable");
  }

  /** Existing DELETE route compatibility only. New callers must cancel. */
  async deleteSubscriptionCompatibility(subscriptionId: string, input: { actorUserId: string; requestId?: string | null }): Promise<boolean> {
    return this.run(async (commands) => {
      await commands.client().$queryRaw`SELECT "id" FROM "plan_subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`;
      const existing = await commands.client().plan_subscriptions.findUnique({ where: { id: subscriptionId } });
      if (!existing) return false;
      if (existing.origin_card_id) throw new RelayError("origin_card_subscription_immutable", "Card-origin Subscription cannot be deleted", 409);
      await commands.client().plan_subscriptions.delete({ where: { id: subscriptionId } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorUserId }, action: "plan_subscription.delete", resourceType: "plan_subscription", resourceId: subscriptionId, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { id: subscriptionId } });
      return true;
    }, 3, "Serializable");
  }

  async grantTeamProviderEntitlement(input: { teamId: string; product: { id: string; code: string; version: number; displayName: string; durationSeconds: number }; actorOwnerUserId: string; idempotencyKey: string; requestId?: string | null }): Promise<{ entitlement: TeamProviderEntitlementSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const idempotencyKeyHash = hashRequired(input.idempotencyKey, "Idempotency-Key");
      const requestHash = digest({ teamId: input.teamId, productId: input.product.id });
      const existing = await commands.client().team_provider_entitlements.findFirst({ where: { issued_by_user_id: input.actorOwnerUserId, idempotency_key_hash: idempotencyKeyHash } });
      if (existing) {
        if (existing.request_hash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Team Provider grant", 409);
        return { entitlement: teamProviderSnapshot(existing), replayed: true };
      }
      await commands.lockTeamProvider(input.teamId);
      const permanent = await commands.client().team_provider_entitlements.findFirst({ where: { team_id: input.teamId, lifecycle: "active", effective_end: null }, select: { id: true } });
      if (permanent) throw new RelayError("team_provider_entitlement_permanent", "Team already has permanent Provider access", 409);
      const at = nowIso();
      const latest = await commands.client().team_provider_entitlements.findFirst({ where: { team_id: input.teamId, lifecycle: "active", effective_end: { gt: at } }, orderBy: [{ effective_end: "desc" }, { id: "desc" }] });
      const effectiveStart = latest?.effective_end ?? at;
      const row = await commands.client().team_provider_entitlements.create({ data: {
        id: createId("team_provider_entitlement"), team_id: input.teamId, source_kind: "admin_grant", source_authority_purchase_id: null,
        source_authority_product_id: input.product.id, source_product_code_snapshot: input.product.code, source_product_version_snapshot: input.product.version,
        source_product_display_name_snapshot: input.product.displayName, buyer_user_id: null, issued_by_user_id: input.actorOwnerUserId,
        effective_start: effectiveStart, effective_end: addSeconds(effectiveStart, input.product.durationSeconds), lifecycle: "active",
        canceled_at: null, canceled_by_user_id: null, cancel_reason_code: null, idempotency_key_hash: idempotencyKeyHash, request_hash: requestHash, created_at: at,
      } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "team_provider_entitlement.grant", resourceType: "team_provider_entitlement", resourceId: row.id, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { teamId: input.teamId, productId: input.product.id, productCode: input.product.code, productVersion: input.product.version, effectiveStart: row.effective_start, effectiveEnd: row.effective_end } });
      return { entitlement: teamProviderSnapshot(row), replayed: false };
    }, 3, "Serializable");
  }

  async createPurchasedTeamProviderEntitlement(input: { teamId: string; purchaseId: string; productId: string; productCode: string; productVersion: number; productDisplayName: string; buyerUserId: string; durationSeconds: number; effectiveAt: string; purchaseAmountUnits: bigint; requestId?: string | null }): Promise<{ entitlement: TeamProviderEntitlementSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const existing = await commands.client().team_provider_entitlements.findUnique({ where: { source_authority_purchase_id: input.purchaseId } });
      if (existing) return { entitlement: teamProviderSnapshot(existing), replayed: true };
      await commands.lockTeamProvider(input.teamId);
      const permanent = await commands.client().team_provider_entitlements.findFirst({ where: { team_id: input.teamId, lifecycle: "active", effective_end: null }, select: { id: true } });
      if (permanent) throw new RelayError("team_provider_entitlement_permanent", "Team already has permanent Provider access", 409);
      const latest = await commands.client().team_provider_entitlements.findFirst({ where: { team_id: input.teamId, lifecycle: "active", effective_end: { gt: input.effectiveAt } }, orderBy: [{ effective_end: "desc" }, { id: "desc" }] });
      const effectiveStart = latest?.effective_end ?? input.effectiveAt;
      const row = await commands.client().team_provider_entitlements.create({ data: {
        id: createId("team_provider_entitlement"), team_id: input.teamId, source_kind: "product_purchase", source_authority_purchase_id: input.purchaseId,
        source_authority_product_id: input.productId, source_product_code_snapshot: input.productCode, source_product_version_snapshot: input.productVersion,
        source_product_display_name_snapshot: input.productDisplayName, buyer_user_id: input.buyerUserId, issued_by_user_id: null,
        effective_start: effectiveStart, effective_end: addSeconds(effectiveStart, input.durationSeconds), lifecycle: "active",
        canceled_at: null, canceled_by_user_id: null, cancel_reason_code: null, idempotency_key_hash: null, request_hash: null, created_at: input.effectiveAt,
      } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.buyerUserId }, action: "team_provider_entitlement.purchase", resourceType: "team_provider_entitlement", resourceId: row.id, result: "success", source: "web", requestId: input.requestId ?? null, metadata: { teamId: input.teamId, productId: input.productId, productCode: input.productCode, productVersion: input.productVersion, purchaseAmountUnits: safeBigIntNumber(input.purchaseAmountUnits), effectiveStart: row.effective_start, effectiveEnd: row.effective_end } });
      return { entitlement: teamProviderSnapshot(row), replayed: false };
    }, 3, "Serializable");
  }

  async cancelTeamProviderEntitlement(input: { entitlementId: string; actorOwnerUserId: string; reasonCode: string; requestId?: string | null }): Promise<TeamProviderEntitlementSnapshot> {
    return this.run(async (commands) => {
      if (!["security_response", "fraud", "product_correction", "operator_error"].includes(input.reasonCode)) throw new RelayError("team_provider_entitlement_cancel_reason_invalid", "Team Provider entitlement cancel reason is invalid", 400);
      await commands.client().$queryRaw`SELECT "id" FROM "team_provider_entitlements" WHERE "id" = ${input.entitlementId} FOR UPDATE`;
      const row = await commands.client().team_provider_entitlements.findUnique({ where: { id: input.entitlementId } });
      if (!row) throw new RelayError("team_provider_entitlement_not_found", "Team Provider entitlement not found", 404);
      if (row.source_kind === "legacy_migration") throw new RelayError("team_provider_entitlement_permanent", "Permanent Team Provider entitlement cannot be canceled", 409);
      if (row.lifecycle === "canceled") {
        if (row.cancel_reason_code !== input.reasonCode) throw new RelayError("team_provider_entitlement_cancel_conflict", "Team Provider entitlement was already canceled with another reason", 409);
        return teamProviderSnapshot(row);
      }
      const updated = await commands.client().team_provider_entitlements.update({ where: { id: row.id }, data: { lifecycle: "canceled", canceled_at: nowIso(), canceled_by_user_id: input.actorOwnerUserId, cancel_reason_code: input.reasonCode } });
      await commands.auditAppender.append(commands.client(), { actor: { actorType: "user", actorId: input.actorOwnerUserId }, action: "team_provider_entitlement.cancel", resourceType: "team_provider_entitlement", resourceId: row.id, result: "success", source: "owner", requestId: input.requestId ?? null, metadata: { teamId: row.team_id, reasonCode: input.reasonCode, sourceKind: row.source_kind } });
      return teamProviderSnapshot(updated);
    }, 3, "Serializable");
  }

  async createPartnerOperatingEntitlement(input: { sourceOrderId: string; ownerUserId: string; partnerTeamId: string; partnerPlanId: string; planSubscriptionId: string; effectiveStart: string; effectiveEnd: string; actor: { actorType: "user" | "system"; actorId: string }; requestId?: string | null }): Promise<{ entitlement: PartnerOperatingEntitlementSnapshot; replayed: boolean }> {
    return this.run(async (commands) => {
      const existing = await commands.client().partner_operating_entitlements.findUnique({ where: { source_order_id: input.sourceOrderId } });
      if (existing) return { entitlement: partnerSnapshot(existing), replayed: true };
      const row = await commands.client().partner_operating_entitlements.create({ data: { id: createId("partner_entitlement"), source_order_id: input.sourceOrderId, owner_user_id: input.ownerUserId, partner_team_id: input.partnerTeamId, partner_plan_id: input.partnerPlanId, plan_subscription_id: input.planSubscriptionId, effective_start: input.effectiveStart, effective_end: input.effectiveEnd, lifecycle: "active", created_at: nowIso() } });
      await commands.auditAppender.append(commands.client(), { actor: input.actor, action: "partner_operating_entitlement.create", resourceType: "partner_operating_entitlement", resourceId: row.id, result: "success", source: input.actor.actorType === "system" ? "system" : "owner", requestId: input.requestId ?? null, metadata: { sourceOrderId: input.sourceOrderId, ownerUserId: input.ownerUserId, partnerTeamId: input.partnerTeamId, planId: input.partnerPlanId, subscriptionId: input.planSubscriptionId, effectiveStart: input.effectiveStart, effectiveEnd: input.effectiveEnd } });
      return { entitlement: partnerSnapshot(row), replayed: false };
    }, 3, "Serializable");
  }

  private async validatePlanDefinition(command: Omit<CreatePlanDefinitionCommand, "requestId" | "id">) {
    if (!isRuntimeScopeRef(command.scopeRef)) throw new RelayError("invalid_scope_ref", `Invalid Plan scope_ref: ${command.scopeRef}`, 400);
    const name = requiredText(command.name, "name", 120);
    const durationSeconds = boundedInteger(command.durationSeconds, "durationSeconds", 1, 315_360_000);
    const status = command.status ?? "enabled";
    const catalogStatus = command.catalogStatus ?? "unlisted";
    if (!(["enabled", "closed", "disabled"] as const).includes(status)) throw new RelayError("invalid_plan_status", "Plan status is invalid", 400);
    if (!(["listed", "unlisted"] as const).includes(catalogStatus)) throw new RelayError("invalid_plan_catalog_status", "Plan catalog status is invalid", 400);
    if (command.financialTerms.billingMode !== "prepaid" && command.financialTerms.billingMode !== "paygo") throw new RelayError("invalid_plan_billing_mode", "Plan billing mode is invalid", 400);
    if (!Number.isFinite(command.financialTerms.purchaseAmount) || command.financialTerms.purchaseAmount < 0 || command.financialTerms.purchaseAmountUnits < 0n) throw new RelayError("invalid_plan_purchase_amount", "Plan purchase amount is invalid", 400);
    if (catalogStatus === "listed" && (status !== "enabled" || command.financialTerms.billingMode !== "prepaid" || command.financialTerms.purchaseAmountUnits <= 0n)) throw new RelayError("invalid_listed_plan", "Listed Plan must be enabled prepaid with a positive duration and purchase amount", 409);
    const owner = await this.client().user_controls.findUnique({ where: { id: command.ownerId }, select: { id: true } });
    if (!owner) throw new RelayError("plan_owner_not_found", "Plan owner not found", 404);
    await this.validatePlanAccessPoints(command.accessPointIds);
    normalizeBudgetLimits(command.budgetLimits);
    return { name, durationSeconds, status, catalogStatus };
  }

  private async validatePlanAccessPoints(accessPointIds: readonly string[]): Promise<void> {
    const ids = [...new Set(accessPointIds)];
    if (ids.length) {
      await this.client().$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "access_points"
        WHERE "id" IN (${Prisma.join(ids)})
        ORDER BY "id"
        FOR UPDATE`;
    }
    const rows = ids.length ? await this.client().accessPoint.findMany({ where: { id: { in: ids }, removedAt: null }, select: { id: true, status: true, exposedModel: true } }) : [];
    if (rows.length !== ids.length) throw new RelayError("access_point_not_found", "AccessPoint not found", 404);
    const models = new Set<string>();
    for (const row of rows) if (row.status === "enabled") {
      if (models.has(row.exposedModel)) throw new RelayError("plan_model_access_point_not_unique", `A Plan can include only one enabled AccessPoint for model ${row.exposedModel}`, 409);
      models.add(row.exposedModel);
    }
  }

  private async replacePlanAccessPoints(planId: string, accessPointIds: readonly string[], at: string): Promise<void> {
    await this.validatePlanAccessPoints(accessPointIds);
    await this.client().plan_access_points.deleteMany({ where: { plan_id: planId } });
    const ids = [...new Set(accessPointIds)];
    if (ids.length) await this.client().plan_access_points.createMany({ data: ids.map((accessPointId) => ({ id: createId("plan_ap"), plan_id: planId, access_point_id: accessPointId, created_at: at })) });
  }

  private async replacePlanBudgetLimits(planId: string, limits: readonly PlanBudgetLimitInput[], at: string): Promise<void> {
    const normalized = normalizeBudgetLimits(limits);
    await this.client().plan_budget_limits.deleteMany({ where: { plan_id: planId } });
    if (normalized.length) await this.client().plan_budget_limits.createMany({ data: normalized.map((limit) => ({ id: createId("plan_limit"), plan_id: planId, limit_scope: limit.limitScope, metric: limit.metric, limit_value: limit.limitValue, limit_amount_units: limit.metric === "amount" ? BigInt(Math.round(limit.limitValue * 1_000_000)) : null, window_type: limit.windowType, window_seconds: limit.windowSeconds, created_at: at })) });
  }

  private async lockPlanSource(planId: string, scopeRef: ScopeRef): Promise<void> {
    await this.client().$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${planId}:${scopeRef}`}))`;
  }

  private async assertNoSubscriptionOverlap(planId: string, scopeRef: ScopeRef, effectiveStart: string, effectiveEnd: string | null, excludingId?: string): Promise<void> {
    const overlap = await this.client().plan_subscriptions.findFirst({ where: {
      plan_id: planId, scope_ref: scopeRef, subscription_lifecycle: "active", ...(excludingId ? { id: { not: excludingId } } : {}),
      ...(effectiveEnd === null ? {} : { effective_start: { lt: effectiveEnd } }),
      OR: [{ effective_end: null }, { effective_end: { gt: effectiveStart } }],
    }, select: { id: true } });
    if (overlap) throw new RelayError("plan_subscription_overlap", "Plan subscription overlaps an active subscription", 409);
  }

  private async lockTeamProvider(teamId: string): Promise<void> {
    await this.client().$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const team = await this.client().teams.findUnique({ where: { id: teamId }, select: { status: true } });
    if (!team || team.status !== "enabled") throw new RelayError("team_not_found", "Enabled Team not found", 404);
    await this.client().$queryRaw`SELECT "id" FROM "team_provider_entitlements" WHERE "team_id" = ${teamId} ORDER BY "effective_start", "id" FOR UPDATE`;
  }
}

function planSnapshot(row: { id: string; owner_id: string; scope_ref: string; name: string; version: number; description: string | null; admin_note: string | null; billing_mode: string; purchase_amount: number; duration_seconds: number; plan_status: string; catalog_status: string; created_at: string; updated_at: string }): PlanDefinitionSnapshot {
  return { id: row.id, ownerId: row.owner_id, scopeRef: row.scope_ref as ScopeRef, name: row.name, version: row.version, description: row.description, adminNote: row.admin_note, billingMode: row.billing_mode as "prepaid" | "paygo", purchaseAmount: row.purchase_amount, durationSeconds: row.duration_seconds, planStatus: row.plan_status as PlanDefinitionSnapshot["planStatus"], catalogStatus: row.catalog_status as PlanDefinitionSnapshot["catalogStatus"], createdAt: row.created_at, updatedAt: row.updated_at };
}

function subscriptionSnapshot(row: { id: string; plan_id: string; source: string; scope_ref: string; purchased_by_user_id: string | null; funding_account_id: string | null; origin_card_id: string | null; priority: number; effective_start: string; effective_end: string | null; subscription_lifecycle: string; created_at: string; updated_at: string }): PlanSubscriptionSnapshot {
  return { id: row.id, planId: row.plan_id, source: row.source, scopeRef: row.scope_ref as ScopeRef, purchasedByUserId: row.purchased_by_user_id, fundingAccountId: row.funding_account_id, originCardId: row.origin_card_id, priority: row.priority, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, subscriptionLifecycle: row.subscription_lifecycle as "active" | "canceled", createdAt: row.created_at, updatedAt: row.updated_at };
}

function planAccessPointSnapshot(row: { id: string; plan_id: string; access_point_id: string; created_at: string }): PlanAccessPointEntitlementSnapshot {
  return { id: row.id, planId: row.plan_id, accessPointId: row.access_point_id, createdAt: row.created_at };
}

function limitSnapshot(row: { id: string; plan_id: string; limit_scope: string; metric: string; limit_value: number; window_type: string; window_seconds: number | null; created_at: string }): PlanBudgetLimitSnapshot {
  return { id: row.id, planId: row.plan_id, limitScope: row.limit_scope as "subscription" | "user", metric: row.metric as "tokens" | "amount", limitValue: row.limit_value, windowType: row.window_type as "fixed" | "cumulative", windowSeconds: row.window_seconds, createdAt: row.created_at };
}

function teamProviderSnapshot(row: { id: string; team_id: string; source_kind: string; source_authority_purchase_id: string | null; source_authority_product_id: string | null; source_product_code_snapshot: string | null; source_product_version_snapshot: number | null; source_product_display_name_snapshot: string | null; buyer_user_id: string | null; issued_by_user_id: string | null; effective_start: string; effective_end: string | null; lifecycle: string; canceled_at: string | null; canceled_by_user_id: string | null; cancel_reason_code: string | null; created_at: string }): TeamProviderEntitlementSnapshot {
  return { id: row.id, teamId: row.team_id, sourceKind: row.source_kind, sourceAuthorityPurchaseId: row.source_authority_purchase_id, sourceAuthorityProductId: row.source_authority_product_id, sourceProductCodeSnapshot: row.source_product_code_snapshot, sourceProductVersionSnapshot: row.source_product_version_snapshot, sourceProductDisplayNameSnapshot: row.source_product_display_name_snapshot, buyerUserId: row.buyer_user_id, issuedByUserId: row.issued_by_user_id, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, lifecycle: row.lifecycle, canceledAt: row.canceled_at, canceledByUserId: row.canceled_by_user_id, cancelReasonCode: row.cancel_reason_code, createdAt: row.created_at };
}

function teamProviderAccessState(rows: readonly TeamProviderEntitlementSnapshot[], at: string): TeamProviderAccessStateSnapshot {
  if (rows.length === 0) return Object.freeze({ state: "not_entitled", entitlement: null, nextEntitlement: null, latestEffectiveEnd: null });
  const eligible = rows.filter((row) => row.lifecycle === "active");
  const current = eligible.find((row) => row.effectiveStart <= at && (row.effectiveEnd === null || row.effectiveEnd > at));
  const nextEntitlement = eligible.find((row) => row.effectiveStart > at) ?? null;
  const latestEnd = rows.reduce<string | null>((latest, row) => row.effectiveEnd && (!latest || row.effectiveEnd > latest) ? row.effectiveEnd : latest, null);
  if (current) return Object.freeze({ state: current.effectiveEnd === null ? "permanent" : "active", entitlement: current, nextEntitlement, latestEffectiveEnd: latestEnd });
  if (nextEntitlement) return Object.freeze({ state: "scheduled", entitlement: null, nextEntitlement, latestEffectiveEnd: latestEnd });
  return Object.freeze({ state: "expired", entitlement: null, nextEntitlement: null, latestEffectiveEnd: latestEnd });
}

function partnerSnapshot(row: { id: string; source_order_id: string; owner_user_id: string; partner_team_id: string; partner_plan_id: string; plan_subscription_id: string; effective_start: string; effective_end: string; lifecycle: string; created_at: string }): PartnerOperatingEntitlementSnapshot {
  return { id: row.id, sourceOrderId: row.source_order_id, ownerUserId: row.owner_user_id, partnerTeamId: row.partner_team_id, partnerPlanId: row.partner_plan_id, planSubscriptionId: row.plan_subscription_id, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, lifecycle: row.lifecycle, createdAt: row.created_at };
}

function normalizeBudgetLimits(input: readonly PlanBudgetLimitInput[]): PlanBudgetLimitInput[] {
  const unique = new Map<string, PlanBudgetLimitInput>();
  for (const value of input) {
    if (value.limitScope !== "subscription" && value.limitScope !== "user") throw new RelayError("invalid_plan_budget_limit", "Plan budget limit scope is invalid", 400);
    if (value.metric !== "tokens" && value.metric !== "amount") throw new RelayError("invalid_plan_budget_limit", "Plan budget metric is invalid", 400);
    if (!Number.isFinite(value.limitValue) || value.limitValue <= 0 || (value.metric === "tokens" && !Number.isSafeInteger(value.limitValue))) throw new RelayError("invalid_plan_budget_limit", "Plan budget value is invalid", 400);
    if (value.windowType !== "fixed" && value.windowType !== "cumulative") throw new RelayError("invalid_plan_budget_limit", "Plan budget window is invalid", 400);
    if (value.windowType === "fixed" && (!Number.isSafeInteger(value.windowSeconds) || (value.windowSeconds ?? 0) <= 0)) throw new RelayError("invalid_plan_budget_limit", "Fixed Plan budget requires positive windowSeconds", 400);
    if (value.windowType === "cumulative" && value.windowSeconds !== null) throw new RelayError("invalid_plan_budget_limit", "Cumulative Plan budget cannot define windowSeconds", 400);
    const normalized = { ...value, windowSeconds: value.windowType === "cumulative" ? null : value.windowSeconds };
    unique.set(JSON.stringify([normalized.limitScope, normalized.metric, normalized.limitValue, normalized.windowType, normalized.windowSeconds]), normalized);
  }
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function sameBudgetLimits(left: readonly PlanBudgetLimitInput[], right: readonly PlanBudgetLimitInput[]): boolean {
  return JSON.stringify(normalizeBudgetLimits(left)) === JSON.stringify(normalizeBudgetLimits(right));
}

function sameAccessPoints(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function requireSubscriptionScope(scopeRef: ScopeRef): void {
  if (!isRuntimeScopeRef(scopeRef) || parseScopeRef(scopeRef).scopeType === "key") throw new RelayError("plan_subscription_scope_not_supported", "Plan subscriptions only support global, team, and user scopes", 400);
}

function normalizeApiKeySourceKeys(sourceKeys: readonly import("./index.js").PlanSourceKey[]): import("./index.js").PlanSourceKey[] {
  if (sourceKeys.length > 1_000) throw new RelayError("api_key_plan_source_selection_limit", "Too many selected Plan sources", 400);
  const unique = new Map<string, import("./index.js").PlanSourceKey>();
  for (const source of sourceKeys) {
    if (!source || typeof source.planId !== "string" || !source.planId.trim() || typeof source.subscriptionScopeRef !== "string") {
      throw new RelayError("api_key_plan_source_invalid", "Each selected Plan source must include a Plan ID and scope", 400);
    }
    const planId = source.planId.trim();
    const subscriptionScopeRef = normalizeScopeRef(source.subscriptionScopeRef, "api_key_plan_source_invalid");
    unique.set(`${planId}\u0000${subscriptionScopeRef}`, { planId, subscriptionScopeRef });
  }
  return [...unique.values()].sort((left, right) => left.planId.localeCompare(right.planId) || left.subscriptionScopeRef.localeCompare(right.subscriptionScopeRef));
}

function normalizeApiKeyTeamScopeRefs(teamScopeRefs: readonly ScopeRef[]): ScopeRef[] {
  if (teamScopeRefs.length > 1_000) throw new RelayError("api_key_team_scope_selection_limit", "Too many selected Team scopes", 400);
  const unique = new Set<string>();
  for (const value of teamScopeRefs) {
    if (typeof value !== "string") throw new RelayError("api_key_team_scope_invalid", "Each selected Team scope must be a Team scope", 400);
    const scopeRef = normalizeScopeRef(value, "api_key_team_scope_invalid");
    if (!scopeRef.startsWith("team:")) throw new RelayError("api_key_team_scope_invalid", "Each selected Team scope must be a Team scope", 400);
    unique.add(scopeRef);
  }
  return [...unique].sort() as ScopeRef[];
}

function normalizeScopeRef(value: string, errorCode: "api_key_plan_source_invalid" | "api_key_team_scope_invalid"): ScopeRef {
  try {
    if (!isRuntimeScopeRef(value)) throw new Error("invalid_scope_ref");
    if (parseScopeRef(value).scopeType === "key") throw new Error("key_scope_not_supported");
    return value;
  } catch {
    throw new RelayError(errorCode, "The selected scope is invalid", 400);
  }
}

function requireInterval(start: string, end: string | null): void {
  if (!Number.isFinite(Date.parse(start)) || (end !== null && (!Number.isFinite(Date.parse(end)) || end <= start))) throw new RelayError("invalid_plan_subscription_period", "Plan Subscription period is invalid", 400);
}

function latestEffectiveEnd(rows: Array<{ effective_end: string | null }>): string | null {
  return rows.reduce<string | null>((latest, row) => row.effective_end && (!latest || row.effective_end > latest) ? row.effective_end : latest, null);
}

function durationDaysFromSeconds(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < SECONDS_PER_DAY || seconds % SECONDS_PER_DAY !== 0) {
    throw new RelayError("authority_product_duration_days_invalid", "Personal Provider product duration must be a positive integer number of days", 400);
  }
  return positiveDurationDays(seconds / SECONDS_PER_DAY);
}

function personalProviderPeriodSnapshot(row: {
  id: string; provider_slot_id: string; user_id: string; source_authority_purchase_id: string; source_authority_product_id: string;
  source_product_code_snapshot: string; source_product_version_snapshot: number; source_product_display_name_snapshot: string;
  purchase_amount_units_snapshot: bigint; duration_days_snapshot: number; renewal_admitted_at: string; fulfillment_succeeded_at: string;
  effective_start: string; effective_end: string; plan_subscription_id: string; lifecycle: string; created_at: string;
}): PersonalProviderEntitlementPeriodSnapshot {
  if (row.lifecycle !== "active") throw new RelayError("provider_slot_period_corrupt", "Personal Provider entitlement period lifecycle is invalid", 500);
  return Object.freeze({
    id: row.id, providerSlotId: row.provider_slot_id, userId: row.user_id, sourceAuthorityPurchaseId: row.source_authority_purchase_id,
    sourceAuthorityProductId: row.source_authority_product_id, sourceProductCodeSnapshot: row.source_product_code_snapshot,
    sourceProductVersionSnapshot: row.source_product_version_snapshot, sourceProductDisplayNameSnapshot: row.source_product_display_name_snapshot,
    purchaseAmountUnitsSnapshot: row.purchase_amount_units_snapshot, durationDaysSnapshot: row.duration_days_snapshot,
    renewalAdmittedAt: row.renewal_admitted_at, fulfillmentSucceededAt: row.fulfillment_succeeded_at,
    effectiveStart: row.effective_start, effectiveEnd: row.effective_end, planSubscriptionId: row.plan_subscription_id,
    lifecycle: "active", createdAt: row.created_at,
  });
}

function addSeconds(value: string, seconds: number): string { return new Date(Date.parse(value) + seconds * 1000).toISOString(); }
function requiredText(value: string, name: string, max = 200): string { const result = value.trim(); if (!result || result.length > max) throw new RelayError("entitlement_text_invalid", `${name} is required`, 400); return result; }
function boundedInteger(value: number, name: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new RelayError("entitlement_integer_invalid", `${name} is invalid`, 400); return value; }
function safeBigIntNumber(value: bigint): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new RelayError("entitlement_integer_invalid", "Entitlement amount is outside the supported range", 500); return result; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function hashRequired(value: string, name: string): string { return createHash("sha256").update(requiredText(value, name)).digest("hex"); }
function normalizePageSize(value: number): number { return [10, 20, 50, 100].includes(value) ? value : 20; }
function encodeCursor(createdAt: string, id: string): string { return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url"); }
function decodeCursor(value: string): { createdAt: string; id: string } { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>; if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" || !parsed.id) throw new Error(); return { createdAt: parsed.createdAt, id: parsed.id }; } catch { throw new RelayError("invalid_team_provider_entitlement_cursor", "Invalid Team Provider entitlement cursor", 400); } }
