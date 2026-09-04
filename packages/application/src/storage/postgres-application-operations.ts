import { createHash, randomBytes } from "node:crypto";
import type { AuditApplicationEvent, AuditInput } from "@frely/audit";
import type { ApiKeyPlanSourceRestrictionDecision } from "@frely/entitlement";
import { PostgresAuditEventAppender } from "@frely/audit/application-internal";
import { Resolver } from "node:dns/promises";
import { AUTHORITY_PRODUCT_LIMITS, createId, isProviderCredentialFailureReason, isRuntimeScopeRef, normalizeAccessPointRequestOverrides, nowIso, parseAccessPointRequestOverridesJson, parseJsonText, parseScopeRef, RelayError, teamScopeRef, userScopeRef, type AccessPointSelectorId, type AccessPointTargetType, type ProviderCredentialFailureReason, type ScopeRef } from "@frely/core";
import { ModelAccessManagementQueryService } from "@frely/model-access/application-internal";
import { recordRepositoryOperation, type RepositoryCollectionAttributes } from "@frely/observability/server";
import {
  PostgresClientOwner,
  createPostgresClient,
  createPostgresClientFromEnvironment,
  isRetryablePostgresTransactionError,
  resolvePostgresConnectionStringFromEnvironment,
  type PostgresClientOptions,
  type PostgresHealth,
  type PostgresTransactionContext,
} from "@frely/postgres/server";
import type { QueryResult, QueryResultRow } from "pg";

export {
  PostgresClientOwner,
  createPostgresClient,
  createPostgresClientFromEnvironment,
  isRetryablePostgresTransactionError,
  resolvePostgresConnectionStringFromEnvironment,
};
export type { PostgresClientOptions, PostgresHealth, PostgresTransactionContext };
import type { AuthorityGrant, AuthorityGrantQuota, AuthorityProduct, AuthorityProductTerms, AuthorityPurchase, AuthorityPurchaseResult, AuthorityRefund, AuthorityRefundResult, AuthorityTeamCreateResult, AuthorityTeamProviderPurchaseResult, AuthorityUse, TeamProviderEntitlement, TeamProviderEntitlementState } from "./authority.js";
import type { AsyncApplicationOperationPort } from "./async-application-operation-port.js";
import type { AuditSource } from "./audit.js";
import { assertCpaInstanceId, assertOrderedPlanSourceConfiguration, billingHistoryReference, DEFAULT_CPA_INSTANCE_ID, normalizeAccessPointDescription, usdToCreditUnits, isPlanRuntimeEnabled, TEAM_DELETION_RETENTION_DAYS } from "./runtime-domain.js";
import type { CardActivationBatch, CardActivationBatchDetail, CardActivationCode, CardActivationCodeStatus, CardActivationCodeView, CardActivationPreview, CardActivationRedeemResult, CardActivationStats, CardIssuanceType, CardType } from "./application-operation-port.js";
import { cardActivationCodeHash, createCardActivationCode, createCardActivationSeed, decryptCardActivationSeed, encryptCardActivationSeed, loadCardActivationKeyring, type CardActivationKeyring } from "./card-activation.js";
import type { PartnerOperatingEntitlement, PartnerOperatingState, PartnerTeamCreationAllocation, ServiceFulfillment, ServiceOrder, ServiceProduct, ServiceProductListing } from "./partner-commerce.js";
import { normalizeDomainHostname, type ActiveDomainBinding, type DomainBinding } from "./domain-binding.js";
import type { ServiceProductDirectoryInput, ServiceProductDirectoryRow, ServiceProductListingProjection } from "./queries/commerce.js";
import type { PageResult } from "./queries/pagination.js";
import type { ScopedAccessPointDirectoryRow } from "./queries/access-points.js";
import type { TeamPlanSubscriptionDirectoryRow, TeamPlanStatusFilter } from "./queries/plans.js";
import type { ResourcePermissionDirectoryRow } from "./queries/teams.js";
import type { AccessPointPriceWorkbenchInput, AccessPointPriceWorkbenchPage, AccessPointPriceWorkbenchRow, PricingWorkbenchSummary, ProviderCostWorkbenchInput, ProviderCostWorkbenchPage, ProviderCostWorkbenchRow } from "./queries/pricing.js";
import type { AccessPoint, AccessPointPrice, AccessPointPriceTier, AccessPointTarget, AccessPointWithRouting, ApiKey, BootstrapOwnerGrant, BudgetPolicy, Card, CardTransfer, CardUseResult, CpaInstance, CreditAccount, CreditLedgerEvent, CreditProduct, CreditProductListing, CreditTopup, CreditTopupAttachment, CreditTransferPolicy, EffectivePlanAccessPointPrice, GovernanceBudgetPolicy, IngressPluginSetting, OidcAccessToken, OidcAuthorizationCode, OidcRefreshToken, PasskeyCredential, PaymentChannel, PaymentChannelInstructionAttachment, PipelinePluginSetting, PlanBillingMode, PlanBudgetLimit, PlanBudgetSourceView, PlanCatalogStatus, PlanDefinition, PlanAccessPointPrice, PlanAccessPointPriceTier, PlanPurchaseOrder, PlanPurchaseResult, PlanStatus, PlanSubscription, PlanSubscriptionEffectiveState, PlanSubscriptionUsageMode, PlanTemplate, PriceTierInput, Provider, ProviderBinding, ProviderModel, ProviderModelCost, ProviderModelCostTier, RefreshToken, ApplicationOperationPort, RequestCaptureSetting, RequestExecutionLease, RequestLog, RequestLogListFilter, ResourcePermission, ScopeBudgetPolicy, ScopeGovernanceBudgetPolicy, SellerSettlementEvent, StripeWebhookEvent, Team, TeamDeletionLifecycle, TeamInviteLink, TeamInviteLinkCreateResult, TeamMembership, User, WebAuthnCeremony, WebAuthnUserHandle, WebRegistrationSetting } from "./application-operation-port.js";
import { PUBLIC_HOST_PAGE_SIZE, type InstancePublicHost } from "./public-host.js";
import type { AbuseRateLimitDecision } from "./application-operation-port.js";
import { assertPrismaMigrationsCurrent, type PrismaMigrationState } from "@frely/postgres/migration-state";
import { PostgresTaskLeaseStore } from "./postgres-task-lease.js";
import type { PostgresTaskLease } from "./postgres-task-lease.js";
import { PostgresShadowRiskStateStore, type PostgresShadowRiskProfile } from "./postgres-risk-state.js";
import { normalizePlanBudgetLimits, planBudgetWindow } from "./plan-budget-limits.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize } from "./queries/pagination.js";
import { CreditCursorError, type UserCardInventoryStatusFilter } from "./queries/credits.js";
import { TeamProviderEntitlementCursorError } from "./queries/authority.js";
import { normalizeStripeCurrency, stripeMinorAmountFromUnits } from "./stripe-currencies.js";

type EmptyPostgresSchema = Record<string, never>;
const POSTGRES_REQUEST_IDENTITY_SOURCE = `SELECT "id" AS "request_id","api_key_id","user_id","team_id","started_at" FROM "request_logs"
  UNION ALL
  SELECT archived."request_id",archived."api_key_id",archived."user_id",archived."team_id",archived."started_at"
  FROM "request_log_archive_entries" archived
  WHERE NOT EXISTS (SELECT 1 FROM "request_logs" hot WHERE hot."id"=archived."request_id")
`;
const POSTGRES_REQUEST_IDENTITY_CTE = `WITH request_identity AS (${POSTGRES_REQUEST_IDENTITY_SOURCE})`;
// The application-facing User projection deliberately keeps the historical
// DTO shape while sourcing identity and credentials from Better Auth's
// standard tables. The nullable legacy columns on user_controls are only
// retained for the rollback window and must not be read by runtime paths.
const POSTGRES_USER_SOURCE = `
  SELECT user_row."id", user_row."team_id", identity."email" AS "email",
         COALESCE(credential."password", '') AS "password_hash",
         user_row."auth_version", user_row."status", user_row."admin_note",
         user_row."api_key_limit", user_row."user_can_create_custom_provider",
         user_row."user_can_create_access_point", user_row."created_at", user_row."updated_at"
  FROM "user_controls" user_row
  INNER JOIN "user" identity ON identity."id" = user_row."id"
  LEFT JOIN LATERAL (
    SELECT account."password"
    FROM "account" account
    WHERE account."user_id" = user_row."id"
      AND account."provider_id" = 'credential'
      AND account."issuer" = 'local:credential'
    ORDER BY account."updated_at" DESC, account."id" DESC
    LIMIT 1
  ) credential ON TRUE`;
type AuthorityProductTermsForPostgres = AuthorityProductTerms & { code: string; actorOwnerUserId: string };
type AuthorityDraftProductInputForPostgres = AuthorityProductTerms & { actorOwnerUserId: string };

export class PostgresApplicationOperations {
  readonly backend = "postgres" as const;
  readonly taskLeases: PostgresTaskLeaseStore;

  constructor(private readonly client: PostgresClientOwner, private readonly transactionContext?: PostgresTransactionContext) {
    this.taskLeases = new PostgresTaskLeaseStore(transactionContext ?? client);
  }

  createShadowRiskStateStore(guardId: string, profile: PostgresShadowRiskProfile): PostgresShadowRiskStateStore {
    if (this.transactionContext) throw new Error("postgres_shadow_risk_store_requires_root_repository");
    return new PostgresShadowRiskStateStore(this.client, guardId, profile);
  }

  health(): Promise<PostgresHealth> {
    return this.client.health();
  }

  async currentDatabaseTime(): Promise<string> {
    const row = await this.one<{ currentTime: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "currentTime"`,
      [],
    );
    if (!row?.currentTime || !Number.isFinite(Date.parse(row.currentTime))) throw new Error("postgres_current_time_invalid");
    return row.currentTime;
  }

  withTransaction<T>(callback: (repository: PostgresApplicationOperations) => Promise<T>): Promise<T> {
    if (this.transactionContext) return callback(new PostgresApplicationOperations(this.client, this.transactionContext));
    return this.client.withTransaction((context) => callback(new PostgresApplicationOperations(this.client, context)));
  }

  withRetriedTransaction<T>(callback: (repository: PostgresApplicationOperations) => Promise<T>, maxAttempts = 3): Promise<T> {
    if (this.transactionContext) return callback(new PostgresApplicationOperations(this.client, this.transactionContext));
    return this.client.withRetriedTransaction((context) => callback(new PostgresApplicationOperations(this.client, context)), maxAttempts);
  }

  withApplicationOperationPortTransaction<T>(callback: (repository: PostgresApplicationOperations) => Promise<T>): Promise<T> {
    return this.withTransaction(callback);
  }

  assertSchemaCompatible(): Promise<PrismaMigrationState> {
    return assertPrismaMigrationsCurrent(this.transactionContext ?? this.client);
  }

  async listTeams(): Promise<Team[]> {
    return this.rows<Team>(`SELECT * FROM "teams" ORDER BY "created_at" ASC, "id" ASC`);
  }

  async pageAdminTeamDirectory(
    input: Parameters<ApplicationOperationPort["pageAdminTeamDirectory"]>[0] = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageAdminTeamDirectory"]>>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const collection: RepositoryCollectionAttributes = { pageSize };
    return recordRepositoryOperation("queries.teams.pageDirectory", async () => {
      const requestedPage = normalizeDirectoryPage(input.page, 10_000);
      const sortColumns = {
        name: 'lower("name")',
        status: '"status"',
        members: '"memberCount"',
        access: '"teamAccessCount"',
        ownerPermissions: '("teamOwnerCanManageMemberApiKeyLimit" + "teamOwnerCanManageMemberCredit" + "teamOwnerCanCreateCustomProvider" + "teamOwnerCanCreateAccessPoint")',
        createdAt: '"createdAt"',
      } as const;
      const sort = sortColumns[input.sort ?? "createdAt"] ?? sortColumns.createdAt;
      const direction = input.direction === "desc" ? "DESC" : "ASC";
      const cte = postgresAdminTeamDirectoryCte();
      const filter = `WHERE $1 = ''
        OR strpos(lower("name"), $1) > 0
        OR strpos(lower("id"), $1) > 0
        OR strpos(CASE lower("status") WHEN 'enabled' THEN 'active' WHEN 'disabled' THEN 'disabled' ELSE lower("status") END, $1) > 0
        OR strpos(CAST("memberCount" AS text), $1) > 0
        OR strpos(CASE WHEN "teamAccessCount" > 0 THEN CAST("teamAccessCount" AS text) || ' team access points' WHEN "inheritedAccessCount" > 0 THEN CAST("inheritedAccessCount" AS text) || ' inherited' ELSE 'no access' END, $1) > 0`;
      const totalRow = await this.one<{ count: number }>(`${cte} SELECT COUNT(*)::int AS "count" FROM directory ${filter}`, [query]);
      const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_admin_team_count_invalid");
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = normalizeDirectoryPage(requestedPage, totalPages);
      const rows = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageAdminTeamDirectory"]>>["rows"][number]>(
        `${cte}
         SELECT * FROM directory ${filter}
         ORDER BY ${sort} ${direction}, "id" ASC
         LIMIT $2 OFFSET $3`,
        [query, pageSize, (page - 1) * pageSize],
      );
      collection.itemsReturned = rows.length;
      collection.returnedRows = rows.length;
      return { items: rows, rows, page, pageSize, total, totalPages };
    }, collection);
  }

  async getAdminTeamDirectoryMetrics(
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getAdminTeamDirectoryMetrics"]>>> {
    const row = await this.one<{
      totalTeams: number;
      activeTeams: number;
      activeUsers: number;
      apiKeyCount: number;
      totalTokens: number;
      totalCost: number;
      totalBudget: number;
    }>(
      `WITH request_identity AS (${POSTGRES_REQUEST_IDENTITY_SOURCE}), active_subscriptions AS (
         SELECT subscription."scope_ref" AS "scopeRef", subscription."plan_id" AS "planId",
                ROW_NUMBER() OVER (PARTITION BY subscription."scope_ref" ORDER BY subscription."priority", subscription."effective_start", subscription."created_at", subscription."id") AS "position"
         FROM "plan_subscriptions" subscription
         WHERE subscription."subscription_lifecycle" = 'active'
           AND subscription."effective_start" <= $1
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $1)
       ), active_team_plans AS (
         SELECT team."id" AS "teamId", active."planId"
         FROM "teams" team
         LEFT JOIN active_subscriptions active ON active."scopeRef" = 'team:' || team."id" AND active."position" = 1
       ), amount_budgets AS (
         SELECT limits."plan_id" AS "planId", limits."limit_value" AS "limitValue",
                ROW_NUMBER() OVER (PARTITION BY limits."plan_id" ORDER BY CASE limits."window_type" WHEN 'cumulative' THEN 0 ELSE 1 END, limits."created_at", limits."id") AS "position"
         FROM "plan_budget_limits" limits
         WHERE limits."limit_scope" = 'subscription' AND limits."metric" = 'amount'
       ), team_usage AS (
         SELECT COALESCE(SUM(event."total_tokens"), 0)::bigint AS "totalTokens", COALESCE(SUM(event."billable_amount"), 0)::double precision AS "totalCost"
         FROM "billing_history_refs" event
         INNER JOIN request_identity request ON request."request_id" = event."request_id"
         INNER JOIN "teams" team ON team."id" = request."team_id"
       )
       SELECT
         (SELECT COUNT(*)::int FROM "teams") AS "totalTeams",
         (SELECT COUNT(*)::int FROM "teams" WHERE "status" = 'enabled') AS "activeTeams",
         (SELECT COUNT(*)::int FROM "user_controls" WHERE "status" = 'enabled') AS "activeUsers",
         (SELECT COUNT(*)::int FROM "api_keys") AS "apiKeyCount",
         (SELECT "totalTokens" FROM team_usage) AS "totalTokens",
         (SELECT "totalCost" FROM team_usage) AS "totalCost",
         COALESCE((SELECT SUM(budget."limitValue") FROM active_team_plans active INNER JOIN amount_budgets budget ON budget."planId" = active."planId" AND budget."position" = 1), 0)::double precision AS "totalBudget"`,
      [at],
    );
    if (!row) throw new Error("postgres_admin_team_metrics_empty");
    return {
      totalTeams: safePostgresInteger(row.totalTeams, "postgres_admin_total_team_count_invalid"),
      activeTeams: safePostgresInteger(row.activeTeams, "postgres_admin_active_team_count_invalid"),
      activeUsers: safePostgresInteger(row.activeUsers, "postgres_admin_active_user_count_invalid"),
      apiKeyCount: safePostgresInteger(row.apiKeyCount, "postgres_admin_api_key_count_invalid"),
      totalTokens: Number(row.totalTokens ?? 0),
      totalCost: Number(row.totalCost ?? 0),
      totalBudget: Number(row.totalBudget ?? 0),
    };
  }

  async getTeam(id: string): Promise<Team | undefined> {
    return this.one<Team>(`SELECT * FROM "teams" WHERE "id" = $1`, [id]);
  }

  async getWebRegistrationSetting(): Promise<WebRegistrationSetting | undefined> {
    return this.one<WebRegistrationSetting>(`SELECT * FROM "web_registration_settings" WHERE "id" = 'global'`, []);
  }

  async updateWebRegistrationSetting(input: {
    defaultTeamId: string | null;
    registrationInviteLinkId: string | null;
    updatedByUserId: string;
  }): Promise<WebRegistrationSetting> {
    const result = await this.query<WebRegistrationSetting>(
      `UPDATE "web_registration_settings"
       SET "default_team_id" = $1, "registration_invite_link_id" = $2,
           "updated_by_user_id" = $3, "updated_at" = $4
       WHERE "id" = 'global' RETURNING *`,
      [input.defaultTeamId, input.registrationInviteLinkId, input.updatedByUserId, nowIso()],
    );
    const row = result.rows[0];
    if (!row) throw new Error("web_registration_setting_not_found");
    return mapPostgresRow<WebRegistrationSetting>(row);
  }

  async getActiveTeamDeletion(teamId: string): Promise<TeamDeletionLifecycle | undefined> {
    return this.one<TeamDeletionLifecycle>(
      `SELECT * FROM "team_deletion_lifecycles"
       WHERE "team_id" = $1 AND "cancelled_at" IS NULL AND "purged_at" IS NULL
       ORDER BY "requested_at" ASC, "id" ASC LIMIT 1`,
      [teamId],
    );
  }

  async assessTeamDeletion(teamId: string): Promise<{
    teamId: string;
    deletable: boolean;
    removableOwnerMembershipId: string | null;
    blockers: Array<{ code: string; count: number }>;
  }> {
    const team = await this.getTeam(teamId);
    if (!team) throw new RelayError("team_not_found", "Team not found", 404);
    const checks = [
      ["non_owner_memberships", `SELECT COUNT(*)::int AS "count" FROM "team_memberships" membership INNER JOIN "teams" team ON team."id" = membership."team_id" WHERE membership."team_id" = $1 AND membership."user_id" <> team."owner_id"`],
      ["request_logs", `SELECT COUNT(*)::int AS "count" FROM "request_logs" WHERE "team_id" = $1`],
      ["request_log_archives", `SELECT COUNT(*)::int AS "count" FROM "request_log_archive_entries" WHERE "team_id" = $1`],
      ["providers", `SELECT COUNT(*)::int AS "count" FROM "providers" WHERE "scope_ref" = 'team:' || $1`],
      ["access_points", `SELECT COUNT(*)::int AS "count" FROM "access_points" WHERE "scope_ref" = 'team:' || $1`],
      ["scope_budget_policies", `SELECT COUNT(*)::int AS "count" FROM "scope_budget_policies" WHERE "scope_ref" = 'team:' || $1`],
      ["scope_governance_budget_policies", `SELECT COUNT(*)::int AS "count" FROM "scope_governance_budget_policies" WHERE "scope_ref" = 'team:' || $1`],
      ["scope_rate_limit_policies", `SELECT COUNT(*)::int AS "count" FROM "scope_rate_limit_policies" WHERE "scope_ref" = 'team:' || $1`],
      ["plans", `SELECT COUNT(*)::int AS "count" FROM "plans" WHERE "scope_ref" = 'team:' || $1`],
      ["plan_subscriptions", `SELECT COUNT(*)::int AS "count" FROM "plan_subscriptions" WHERE "scope_ref" = 'team:' || $1`],
      ["user_model_plan_scope_orders", `SELECT COUNT(*)::int AS "count" FROM "user_model_plan_scope_orders" WHERE "subscription_scope_ref" = 'team:' || $1`],
      ["ingress_plugin_settings", `SELECT COUNT(*)::int AS "count" FROM "ingress_plugin_settings" WHERE "scope_ref" = 'team:' || $1`],
      ["pipeline_plugin_settings", `SELECT COUNT(*)::int AS "count" FROM "pipeline_plugin_settings" WHERE "scope_ref" = 'team:' || $1`],
      ["credit_accounts", `SELECT COUNT(*)::int AS "count" FROM "credit_accounts" WHERE "scope_ref" = 'team:' || $1`],
      ["credit_ledger_events", `SELECT COUNT(*)::int AS "count" FROM "credit_ledger_events" event INNER JOIN "credit_accounts" account ON account."id" = event."account_id" WHERE account."scope_ref" = 'team:' || $1`],
      ["credit_transfer_policies", `SELECT COUNT(*)::int AS "count" FROM "credit_transfer_policies" WHERE "scope_ref" = 'team:' || $1`],
      ["credit_topups", `SELECT COUNT(*)::int AS "count" FROM "credit_topups" WHERE "scope_ref" = 'team:' || $1`],
      ["billing_events", `SELECT COUNT(*)::int AS "count" FROM "billing_events" WHERE "billing_scope_ref" = 'team:' || $1`],
      ["billing_access_point_edges", `SELECT COUNT(*)::int AS "count" FROM "billing_access_point_edges" WHERE "buyer_scope_ref" = 'team:' || $1 OR "seller_scope_ref" = 'team:' || $1`],
      ["billing_provider_cost_events", `SELECT COUNT(*)::int AS "count" FROM "billing_provider_cost_events" WHERE "provider_owner_scope_ref" = 'team:' || $1`],
      ["seller_settlement_events", `SELECT COUNT(*)::int AS "count" FROM "seller_settlement_events" WHERE "seller_scope_ref" = 'team:' || $1`],
      ["domain_binding_teams", `SELECT COUNT(*)::int AS "count" FROM "domain_binding_teams" WHERE "team_id" = $1`],
      ["domain_binding_default_registration", `SELECT COUNT(*)::int AS "count" FROM "domain_bindings" WHERE "default_registration_team_id" = $1`],
      ["domain_binding_registration_invites", `SELECT COUNT(*)::int AS "count" FROM "domain_bindings" binding INNER JOIN "team_invite_links" invite ON invite."id" = binding."registration_invite_link_id" WHERE invite."team_id" = $1`],
      ["web_registration_setting", `SELECT COUNT(*)::int AS "count" FROM "web_registration_settings" WHERE "default_team_id" = $1`],
      ["service_orders", `SELECT COUNT(*)::int AS "count" FROM "service_orders" WHERE "target_partner_team_id" = $1`],
      ["partner_team_creation_allocations", `SELECT COUNT(*)::int AS "count" FROM "partner_team_creation_allocations" WHERE "consumed_team_id" = $1`],
      ["partner_operating_entitlements", `SELECT COUNT(*)::int AS "count" FROM "partner_operating_entitlements" WHERE "partner_team_id" = $1`],
    ] as const;
    const rows = await Promise.all(checks.map(async ([code, sql]) => ({ code, count: safePostgresInteger((await this.one<{ count: number }>(sql, [teamId]))?.count ?? 0, `postgres_team_delete_${code}_count_invalid`) })));
    const blockers = rows.filter((row) => row.count > 0);
    const ownerMembership = await this.one<{ id: string }>(
      `SELECT "id" FROM "team_memberships" WHERE "team_id" = $1 AND "user_id" = $2 LIMIT 1`,
      [teamId, team.ownerId],
    );
    return {
      teamId,
      deletable: blockers.length === 0,
      removableOwnerMembershipId: blockers.length === 0 ? ownerMembership?.id ?? null : null,
      blockers,
    };
  }

  async listTeamDeleteBlockersForTeams(teamIds: string[]): Promise<Map<string, Array<{ code: string; count: number }>>> {
    const ids = [...new Set(teamIds)].slice(0, 50);
    const blockers = new Map(ids.map((teamId) => [teamId, [] as Array<{ code: string; count: number }> ]));
    if (ids.length === 0) return blockers;
    const rows = await this.rows<{ teamId: string; code: string; count: number }>(
      `WITH requested AS (
         SELECT unnest($1::text[]) AS team_id
       ), blocker_counts AS (
         SELECT requested.team_id, 'non_owner_memberships' AS code, COUNT(*)::int AS count
         FROM requested
         INNER JOIN "team_memberships" membership ON membership."team_id" = requested.team_id
         INNER JOIN "teams" team ON team."id" = membership."team_id"
         WHERE membership."user_id" <> team."owner_id"
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'request_logs', COUNT(*)::int
         FROM requested INNER JOIN "request_logs" log ON log."team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'request_log_archives', COUNT(*)::int
         FROM requested INNER JOIN "request_log_archive_entries" entry ON entry."team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'providers', COUNT(*)::int
         FROM requested INNER JOIN "providers" provider ON provider."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'access_points', COUNT(*)::int
         FROM requested INNER JOIN "access_points" access_point ON access_point."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'scope_budget_policies', COUNT(*)::int
         FROM requested INNER JOIN "scope_budget_policies" policy ON policy."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'scope_governance_budget_policies', COUNT(*)::int
         FROM requested INNER JOIN "scope_governance_budget_policies" policy ON policy."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'scope_rate_limit_policies', COUNT(*)::int
         FROM requested INNER JOIN "scope_rate_limit_policies" policy ON policy."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'plans', COUNT(*)::int
         FROM requested INNER JOIN "plans" plan ON plan."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'plan_subscriptions', COUNT(*)::int
         FROM requested INNER JOIN "plan_subscriptions" subscription ON subscription."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'user_model_plan_scope_orders', COUNT(*)::int
         FROM requested INNER JOIN "user_model_plan_scope_orders" scope_order ON scope_order."subscription_scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'ingress_plugin_settings', COUNT(*)::int
         FROM requested INNER JOIN "ingress_plugin_settings" setting ON setting."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'pipeline_plugin_settings', COUNT(*)::int
         FROM requested INNER JOIN "pipeline_plugin_settings" setting ON setting."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'credit_accounts', COUNT(*)::int
         FROM requested INNER JOIN "credit_accounts" account ON account."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'credit_ledger_events', COUNT(*)::int
         FROM requested
         INNER JOIN "credit_accounts" account ON account."scope_ref" = 'team:' || requested.team_id
         INNER JOIN "credit_ledger_events" event ON event."account_id" = account."id"
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'credit_transfer_policies', COUNT(*)::int
         FROM requested INNER JOIN "credit_transfer_policies" policy ON policy."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'credit_topups', COUNT(*)::int
         FROM requested INNER JOIN "credit_topups" topup ON topup."scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'billing_events', COUNT(*)::int
         FROM requested INNER JOIN "billing_events" event ON event."billing_scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'billing_access_point_edges', COUNT(*)::int
         FROM requested INNER JOIN "billing_access_point_edges" edge
           ON edge."buyer_scope_ref" = 'team:' || requested.team_id OR edge."seller_scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'billing_provider_cost_events', COUNT(*)::int
         FROM requested INNER JOIN "billing_provider_cost_events" event ON event."provider_owner_scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'seller_settlement_events', COUNT(*)::int
         FROM requested INNER JOIN "seller_settlement_events" event ON event."seller_scope_ref" = 'team:' || requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'domain_binding_teams', COUNT(*)::int
         FROM requested INNER JOIN "domain_binding_teams" binding_team ON binding_team."team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'domain_binding_default_registration', COUNT(*)::int
         FROM requested INNER JOIN "domain_bindings" binding ON binding."default_registration_team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'domain_binding_registration_invites', COUNT(*)::int
         FROM requested
         INNER JOIN "team_invite_links" invite ON invite."team_id" = requested.team_id
         INNER JOIN "domain_bindings" binding ON binding."registration_invite_link_id" = invite."id"
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'web_registration_setting', COUNT(*)::int
         FROM requested INNER JOIN "web_registration_settings" setting ON setting."default_team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'service_orders', COUNT(*)::int
         FROM requested INNER JOIN "service_orders" order_row ON order_row."target_partner_team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'partner_team_creation_allocations', COUNT(*)::int
         FROM requested INNER JOIN "partner_team_creation_allocations" allocation ON allocation."consumed_team_id" = requested.team_id
         GROUP BY requested.team_id
         UNION ALL
         SELECT requested.team_id, 'partner_operating_entitlements', COUNT(*)::int
         FROM requested INNER JOIN "partner_operating_entitlements" entitlement ON entitlement."partner_team_id" = requested.team_id
         GROUP BY requested.team_id
       )
       SELECT team_id AS "teamId", code, count
       FROM blocker_counts
       WHERE count > 0
       ORDER BY team_id ASC, code ASC`,
      [ids],
    );
    for (const row of rows) {
      const target = blockers.get(row.teamId);
      if (target) target.push({ code: row.code, count: safePostgresInteger(row.count, `postgres_team_delete_${row.code}_count_invalid`) });
    }
    return blockers;
  }

  async getTeamDeletionLifecycle(id: string): Promise<TeamDeletionLifecycle | undefined> {
    return this.one<TeamDeletionLifecycle>(`SELECT * FROM "team_deletion_lifecycles" WHERE "id" = $1`, [id]);
  }

  async requestTeamDeletion(teamId: string, requestedByUserId: string, requestedAt = nowIso()): Promise<TeamDeletionLifecycle> {
    if (teamId === "team_default") throw new RelayError("default_team_protected", "Default Team cannot be deleted", 409);
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getActiveTeamDeletion(teamId);
      if (existing) return existing;
      const team = await transaction.one<Team>(`SELECT * FROM "teams" WHERE "id" = $1 FOR UPDATE`, [teamId]);
      if (!team) throw new RelayError("team_not_found", "Team not found", 404);
      const purgeNotBefore = new Date(Date.parse(requestedAt) + TEAM_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const lifecycle = await transaction.insertRow<TeamDeletionLifecycle>("team_deletion_lifecycles", {
        id: createId("team_deletion"), teamId, requestedAt, requestedByUserId, purgeNotBefore,
        archiveStatus: "pending", archiveManifestId: null, archiveManifestObjectKey: null,
        archiveManifestSha256: null, archiveCoverageJson: null, archivedAt: null, cancelledAt: null, purgedAt: null,
      });
      await transaction.query(`UPDATE "teams" SET "status" = 'disabled', "updated_at" = $2 WHERE "id" = $1`, [teamId, requestedAt]);
      await transaction.query(`UPDATE "team_invite_links" SET "status" = 'disabled', "updated_at" = $2 WHERE "team_id" = $1 AND "status" = 'enabled'`, [teamId, requestedAt]);
      return lifecycle;
    });
  }

  async cancelTeamDeletion(teamId: string, cancelledAt = nowIso()): Promise<TeamDeletionLifecycle> {
    if (teamId === "team_default") throw new RelayError("default_team_protected", "Default Team deletion lifecycle is protected", 409);
    return this.withRetriedTransaction(async (transaction) => {
      const lifecycle = await transaction.getActiveTeamDeletion(teamId);
      if (!lifecycle) throw new RelayError("team_deletion_not_active", "Team is not soft-deleted", 409);
      const updated = await transaction.query<TeamDeletionLifecycle>(
        `UPDATE "team_deletion_lifecycles" SET "cancelled_at" = $2 WHERE "id" = $1 RETURNING *`,
        [lifecycle.id, cancelledAt],
      );
      await transaction.query(`UPDATE "teams" SET "status" = 'enabled', "updated_at" = $2 WHERE "id" = $1`, [teamId, cancelledAt]);
      if (!updated.rows[0]) throw new RelayError("team_deletion_not_active", "Team is not soft-deleted", 409);
      return mapPostgresRow<TeamDeletionLifecycle>(updated.rows[0]);
    });
  }

  async isTeamAvailable(teamId: string): Promise<boolean> {
    const team = await this.getTeam(teamId);
    if (!team || team.status !== "enabled") return false;
    return !(await this.getActiveTeamDeletion(teamId));
  }

  async upsertTeam(input: Partial<Team> & { name: string; ownerId?: string }): Promise<Team> {
    const existing = input.id ? await this.getTeam(input.id) : undefined;
    const now = nowIso();
    const row: Team = {
      id: input.id ?? createId("team"),
      ownerId: input.ownerId ?? existing?.ownerId ?? (() => { throw new Error("postgres_team_owner_required"); })(),
      name: input.name,
      status: input.status ?? existing?.status ?? "enabled",
      teamOwnerCanManageMemberApiKeyLimit: input.teamOwnerCanManageMemberApiKeyLimit ?? existing?.teamOwnerCanManageMemberApiKeyLimit ?? 0,
      teamOwnerCanManageMemberCredit: input.teamOwnerCanManageMemberCredit ?? existing?.teamOwnerCanManageMemberCredit ?? 0,
      teamOwnerCanCreateCustomProvider: input.teamOwnerCanCreateCustomProvider ?? existing?.teamOwnerCanCreateCustomProvider ?? 0,
      teamOwnerCanCreateAccessPoint: input.teamOwnerCanCreateAccessPoint ?? existing?.teamOwnerCanCreateAccessPoint ?? 0,
      inviteEmailDomainPattern: input.inviteEmailDomainPattern ?? existing?.inviteEmailDomainPattern ?? null,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.upsertRow<Team>("teams", row, ["id"], [
      "ownerId", "name", "status", "teamOwnerCanManageMemberApiKeyLimit", "teamOwnerCanManageMemberCredit",
      "teamOwnerCanCreateCustomProvider", "teamOwnerCanCreateAccessPoint", "inviteEmailDomainPattern", "updatedAt",
    ]).then(async (team) => {
      await this.seedDefaultTeamResourcePermissions(team.id);
      return team;
    });
  }

  async createTeam(input: Pick<Team, "id" | "ownerId" | "name" | "status" | "createdAt" | "updatedAt"> & Partial<Team>): Promise<Team> {
    const result = await this.query<Team>(
      `INSERT INTO "teams" (id, owner_id, name, status, team_owner_can_manage_member_api_key_limit, team_owner_can_manage_member_credit, team_owner_can_create_custom_provider, team_owner_can_create_access_point, invite_email_domain_pattern, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        input.id,
        input.ownerId,
        input.name,
        input.status,
        input.teamOwnerCanManageMemberApiKeyLimit ?? 0,
        input.teamOwnerCanManageMemberCredit ?? 0,
        input.teamOwnerCanCreateCustomProvider ?? 0,
        input.teamOwnerCanCreateAccessPoint ?? 0,
        input.inviteEmailDomainPattern ?? null,
        input.createdAt,
        input.updatedAt,
      ],
    );
    const team = mapPostgresRow<Team>(result.rows[0]!);
    await this.seedDefaultTeamResourcePermissions(team.id);
    return team;
  }

  async listUsers(): Promise<User[]> {
    return this.rows<User>(`SELECT * FROM (${POSTGRES_USER_SOURCE}) user_row ORDER BY user_row."created_at" ASC, user_row."id" ASC`);
  }

  async listUsersByTeam(teamId: string): Promise<User[]> {
    return this.rows<User>(`SELECT * FROM (${POSTGRES_USER_SOURCE}) user_row WHERE user_row."team_id" = $1 ORDER BY user_row."created_at" ASC, user_row."id" ASC`, [teamId]);
  }

  async pageOwnerUserDirectory(
    input: Parameters<ApplicationOperationPort["pageOwnerUserDirectory"]>[0] = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageOwnerUserDirectory"]>>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const requestedPage = normalizeDirectoryPage(input.page, 10_000);
    const sortColumns = {
      user: 'lower("email")',
      team: 'lower("teamName")',
      role: '"roleRank"',
      status: '"status"',
      apiKeys: '"apiKeyCount"',
      lastSeen: '"lastSeenAt"',
      createdAt: '"createdAt"',
    } as const;
    const sort = sortColumns[input.sort ?? "user"] ?? sortColumns.user;
    const direction = input.direction === "desc" ? "DESC" : "ASC";
    const cte = postgresOwnerUserDirectoryCte();
    const filter = `WHERE $1 = '' OR strpos(lower("id"), $1) > 0 OR strpos(lower("email"), $1) > 0 OR strpos(lower("teamId"), $1) > 0 OR strpos(lower("teamName"), $1) > 0 OR strpos(lower("roleDetails"), $1) > 0 OR strpos(lower("status"), $1) > 0`;
    const totalRow = await this.one<{ count: number }>(`${cte} SELECT COUNT(*)::int AS "count" FROM directory ${filter}`, [query]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_owner_user_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(requestedPage, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageOwnerUserDirectory"]>>["items"][number]>(
      `${cte}
       SELECT * FROM directory ${filter}
       ORDER BY ${sort} ${direction}, "id" ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async getOwnerUserDirectoryMetrics(): Promise<Awaited<ReturnType<ApplicationOperationPort["getOwnerUserDirectoryMetrics"]>>> {
    const row = await this.one<{ totalUsers: number; activeUsers: number; totalApiKeys: number; usersWithKeys: number; teamOwners: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM "user_controls") AS "totalUsers",
         (SELECT COUNT(*)::int FROM "user_controls" WHERE "status" = 'enabled') AS "activeUsers",
         (SELECT COUNT(*)::int FROM "api_keys") AS "totalApiKeys",
         (SELECT COUNT(DISTINCT "user_id")::int FROM "api_keys") AS "usersWithKeys",
         (SELECT COUNT(DISTINCT "owner_id")::int FROM "teams" WHERE "status" = 'enabled') AS "teamOwners"`,
      [],
    );
    return {
      totalUsers: safePostgresInteger(row?.totalUsers ?? 0, "postgres_owner_total_user_count_invalid"),
      activeUsers: safePostgresInteger(row?.activeUsers ?? 0, "postgres_owner_active_user_count_invalid"),
      totalApiKeys: safePostgresInteger(row?.totalApiKeys ?? 0, "postgres_owner_total_api_key_count_invalid"),
      usersWithKeys: safePostgresInteger(row?.usersWithKeys ?? 0, "postgres_owner_users_with_keys_invalid"),
      teamOwners: safePostgresInteger(row?.teamOwners ?? 0, "postgres_owner_team_owner_count_invalid"),
    };
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.one<User>(`SELECT * FROM (${POSTGRES_USER_SOURCE}) user_row WHERE user_row."id" = $1`, [id]);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return this.one<User>(`SELECT * FROM (${POSTGRES_USER_SOURCE}) user_row WHERE user_row."email" = $1`, [email]);
  }

  async upsertUser(input: Partial<User> & { teamId: string; email: string; passwordHash: string; createMembership?: boolean }): Promise<User> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = input.id ? await transaction.getUser(input.id) : undefined;
      if (existing && input.status !== undefined && input.status !== "enabled") {
        const owner = await transaction.one<{ id: string }>(
          `SELECT "id" FROM "authority_grants"
           WHERE "beneficiary_user_id" = $1 AND "role_domain" = 'platform'
             AND "role_code" = 'owner' AND "lifecycle" = 'active'
           LIMIT 1`,
          [existing.id],
        );
        if (owner) throw new RelayError("platform_owner_status_change_blocked", "Handover Platform Owner before disabling this user", 409);
      }
      const now = nowIso();
      const id = input.id ?? createId("user");
      const email = input.email.toLowerCase();
      const control = {
        id,
        teamId: input.teamId,
        authVersion: existing?.authVersion ?? input.authVersion ?? 1,
        status: input.status ?? existing?.status ?? "enabled",
        adminNote: input.adminNote ?? existing?.adminNote ?? null,
        apiKeyLimit: input.apiKeyLimit ?? existing?.apiKeyLimit ?? 3,
        userCanCreateCustomProvider: input.userCanCreateCustomProvider ?? existing?.userCanCreateCustomProvider ?? 0,
        userCanCreateAccessPoint: input.userCanCreateAccessPoint ?? existing?.userCanCreateAccessPoint ?? 0,
        createdAt: input.createdAt ?? existing?.createdAt ?? now,
        updatedAt: now,
      };
      await transaction.upsertRow<User>("user_controls", control, ["id"], [
        "teamId", "status", "adminNote", "apiKeyLimit", "userCanCreateCustomProvider", "userCanCreateAccessPoint", "updatedAt",
      ]);
      await transaction.upsertBetterAuthIdentity({ id, email, passwordHash: existing?.passwordHash ?? input.passwordHash, createdAt: control.createdAt, updatedAt: now });
      if (!existing && input.createMembership !== false) await transaction.grantTeamMembership(input.teamId, id);
      const user = await transaction.getUser(id);
      if (!user) throw new Error("postgres_user_upsert_readback_empty");
      return user;
    });
  }

  async createUser(input: Pick<User, "id" | "teamId" | "email" | "passwordHash" | "status" | "createdAt" | "updatedAt"> & Partial<User>): Promise<User> {
    return this.withRetriedTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO "user_controls" (id, team_id, auth_version, status, admin_note, api_key_limit, user_can_create_custom_provider, user_can_create_access_point, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.id,
          input.teamId,
          input.authVersion ?? 1,
          input.status,
          input.adminNote ?? null,
          input.apiKeyLimit ?? 3,
          input.userCanCreateCustomProvider ?? 0,
          input.userCanCreateAccessPoint ?? 0,
          input.createdAt,
          input.updatedAt,
        ],
      );
      await transaction.upsertBetterAuthIdentity({ id: input.id, email: input.email.toLowerCase(), passwordHash: input.passwordHash, createdAt: input.createdAt, updatedAt: input.updatedAt });
      const user = await transaction.getUser(input.id);
      if (!user) throw new Error("postgres_user_create_readback_empty");
      return user;
    });
  }

  async getTeamMembership(teamId: string, userId: string): Promise<TeamMembership | undefined> {
    return this.one<TeamMembership>(
      `SELECT * FROM "team_memberships" WHERE "team_id" = $1 AND "user_id" = $2`,
      [teamId, userId],
    );
  }

  async listTeamMemberships(userId: string): Promise<TeamMembership[]> {
    return this.rows<TeamMembership>(
      `SELECT * FROM "team_memberships" WHERE "user_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
      [userId],
    );
  }

  async listAvailableTeamMemberships(userId: string): Promise<TeamMembership[]> {
    return this.rows<TeamMembership>(
      `SELECT membership.*
       FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
       WHERE membership."user_id" = $1
         AND NOT EXISTS (
           SELECT 1 FROM "team_deletion_lifecycles" deletion
           WHERE deletion."team_id" = team."id"
             AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
         )
       ORDER BY membership."created_at" ASC, membership."id" ASC`,
      [userId],
    );
  }

  async pageUserTeamDirectory(userId: string, input: { query?: string; page?: number; pageSize?: number } = {}): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserTeamDirectory"]>>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const countResult = await this.query<{ total: number; owner_teams: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE team."owner_id" = $1)::int AS owner_teams
       FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id"
       WHERE membership."user_id" = $1
         AND team."status" = 'enabled'
         AND ($2 = '' OR lower(team."id") LIKE '%' || $2 || '%'
              OR lower(team."name") LIKE '%' || $2 || '%'
              OR lower(membership."roles_json") LIKE '%' || $2 || '%'
              OR ($2 = 'owner' AND team."owner_id" = $1)
              OR 'active' LIKE '%' || $2 || '%')`,
      [userId, query],
    );
    const count = countResult.rows[0];
    const total = safePostgresInteger(count?.total, "postgres_user_team_count_invalid");
    const ownerTeams = safePostgresInteger(count?.owner_teams, "postgres_user_owner_team_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const result = await this.query(
      `SELECT team."id", team."name", team."owner_id", membership."roles_json", team."status"
       FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id"
       WHERE membership."user_id" = $1
         AND team."status" = 'enabled'
         AND ($2 = '' OR lower(team."id") LIKE '%' || $2 || '%'
              OR lower(team."name") LIKE '%' || $2 || '%'
              OR lower(membership."roles_json") LIKE '%' || $2 || '%'
              OR ($2 = 'owner' AND team."owner_id" = $1)
              OR 'active' LIKE '%' || $2 || '%')
       ORDER BY lower(team."name") ASC, team."id" ASC
       LIMIT $3 OFFSET $4`,
      [userId, query, pageSize, (page - 1) * pageSize],
    );
    return { items: result.rows.map((row) => mapPostgresRow(row)), page, pageSize, total, totalPages, ownerTeams };
  }

  async userNavigationSummary(userId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["userNavigationSummary"]>>> {
    const totalResult = await this.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id"
       WHERE membership."user_id" = $1 AND team."status" = 'enabled'`,
      [userId],
    );
    const result = await this.query(
      `SELECT team."id", team."name", team."owner_id", membership."roles_json", team."status"
       FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id"
       WHERE membership."user_id" = $1 AND team."status" = 'enabled'
       ORDER BY lower(team."name") ASC, team."id" ASC
       LIMIT 2`,
      [userId],
    );
    return { items: result.rows.map((row) => mapPostgresRow(row)), total: safePostgresInteger(totalResult.rows[0]?.count, "postgres_user_navigation_count_invalid") };
  }

  async getUserTeamIdentity(userId: string, teamId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getUserTeamIdentity"]>>> {
    return this.one(
      `SELECT team."id", team."name", team."owner_id", membership."roles_json", team."status"
       FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id"
       WHERE membership."user_id" = $1 AND membership."team_id" = $2 AND team."status" = 'enabled'`,
      [userId, teamId],
    );
  }

  async getUserDirectoryFacts(input: { memberTeamIds?: string[]; usageTeamIds?: string[]; billingTeamIds?: string[] }, at = nowIso()): Promise<Awaited<ReturnType<ApplicationOperationPort["getUserDirectoryFacts"]>>> {
    const memberTeamIds = [...new Set(input.memberTeamIds ?? [])].slice(0, 50);
    const usageTeamIds = [...new Set(input.usageTeamIds ?? [])].slice(0, 50);
    const billingTeamIds = [...new Set(input.billingTeamIds ?? [])].slice(0, 50);
    const [members, usage, plans] = await Promise.all([
      memberTeamIds.length === 0 ? Promise.resolve([]) : this.rows<{ teamId: string; value: number }>(
        `SELECT "team_id" AS "teamId", COUNT(*)::int AS value
         FROM "team_memberships" WHERE "team_id" = ANY($1::text[]) GROUP BY "team_id"`,
        [memberTeamIds],
      ),
      usageTeamIds.length === 0 ? Promise.resolve([]) : this.rows<{ teamId: string; value: number }>(
        `SELECT request."team_id" AS "teamId", COALESCE(SUM(event."total_tokens"), 0)::bigint AS value
         FROM (${POSTGRES_REQUEST_IDENTITY_SOURCE}) request
         INNER JOIN "billing_history_refs" event ON event."request_id" = request."request_id"
         WHERE request."team_id" = ANY($1::text[]) GROUP BY request."team_id"`,
        [usageTeamIds],
      ),
      billingTeamIds.length === 0 ? Promise.resolve([]) : this.rows<{ scopeRef: string; name: string }>(
        `WITH ranked AS (
           SELECT subscription."scope_ref" AS "scopeRef", plan."name",
                  ROW_NUMBER() OVER (
                    PARTITION BY subscription."scope_ref"
                    ORDER BY subscription."priority" ASC, subscription."effective_start" ASC,
                             subscription."created_at" ASC, subscription."id" ASC
                  ) AS position
           FROM "plan_subscriptions" subscription
           INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
             AND plan."plan_status" IN ('enabled', 'closed')
           WHERE subscription."scope_ref" = ANY($1::text[])
             AND subscription."subscription_lifecycle" = 'active'
             AND subscription."effective_start" <= $2
             AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)
         )
         SELECT "scopeRef", "name" FROM ranked WHERE position = 1`,
        [billingTeamIds.map((teamId) => `team:${teamId}`), at],
      ),
    ]);
    return {
      memberCounts: Object.fromEntries(members.map((row) => [row.teamId, safePostgresInteger(row.value, "postgres_member_count_invalid")])),
      usageTokens: Object.fromEntries(usage.map((row) => [row.teamId, safePostgresInteger(row.value, "postgres_usage_token_count_invalid")])),
      planNames: Object.fromEntries(plans.map((row) => [row.scopeRef.slice(5), row.name])),
    };
  }

  async pageTeamMemberSummaries(teamId: string, page = 1, pageSize?: number): Promise<Awaited<ReturnType<ApplicationOperationPort["pageTeamMemberSummaries"]>>> {
    const normalizedPageSize = normalizeDirectoryPageSize(pageSize);
    const totalResult = await this.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "team_memberships" WHERE "team_id" = $1`, [teamId]);
    const total = safePostgresInteger(totalResult.rows[0]?.count, "postgres_team_member_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["getTeamMemberSummary"]>> & { membershipRolesJson: string }>(
      `SELECT user_row."id", identity."email", user_row."status", user_row."api_key_limit",
              user_row."created_at", membership."roles_json", COUNT(DISTINCT api_key."id")::int AS "api_key_count",
              MAX(request."started_at") AS "last_seen_at",
              CASE WHEN EXISTS (
                SELECT 1 FROM "authority_grants" grant_row
                WHERE grant_row."beneficiary_user_id" = user_row."id"
                  AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
                  AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
              ) THEN 1 ELSE 0 END AS "is_platform_owner"
       FROM "team_memberships" membership
       INNER JOIN "user_controls" user_row ON user_row."id" = membership."user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       LEFT JOIN "api_keys" api_key ON api_key."user_id" = user_row."id"
       LEFT JOIN (${POSTGRES_REQUEST_IDENTITY_SOURCE}) request ON request."user_id" = user_row."id"
       WHERE membership."team_id" = $1
       GROUP BY user_row."id", identity."email", membership."id", membership."roles_json"
       ORDER BY user_row."created_at" ASC, user_row."id" ASC
       LIMIT $2 OFFSET $3`,
      [teamId, normalizedPageSize, (normalizedPage - 1) * normalizedPageSize],
    );
    return { items: items as Awaited<ReturnType<ApplicationOperationPort["pageTeamMemberSummaries"]>>["items"], page: normalizedPage, pageSize: normalizedPageSize, total, totalPages };
  }

  async getTeamMemberSummary(teamId: string, userId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getTeamMemberSummary"]>>> {
    return this.one(
      `SELECT user_row."id", identity."email", user_row."status", user_row."api_key_limit",
              user_row."created_at", membership."roles_json", COUNT(DISTINCT api_key."id")::int AS "api_key_count",
              MAX(request."started_at") AS "last_seen_at",
              CASE WHEN EXISTS (
                SELECT 1 FROM "authority_grants" grant_row
                WHERE grant_row."beneficiary_user_id" = user_row."id"
                  AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
                  AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
              ) THEN 1 ELSE 0 END AS "is_platform_owner"
       FROM "team_memberships" membership
       INNER JOIN "user_controls" user_row ON user_row."id" = membership."user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       LEFT JOIN "api_keys" api_key ON api_key."user_id" = user_row."id"
       LEFT JOIN (${POSTGRES_REQUEST_IDENTITY_SOURCE}) request ON request."user_id" = user_row."id"
       WHERE membership."team_id" = $1 AND membership."user_id" = $2
       GROUP BY user_row."id", identity."email", membership."id", membership."roles_json"
       LIMIT 1`,
      [teamId, userId],
    );
  }

  async getTeamDetailCounts(teamId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getTeamDetailCounts"]>>> {
    const row = await this.one<{ memberCount: number; teamAccessCount: number; inheritedAccessCount: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM "team_memberships" membership WHERE membership."team_id" = $1) AS "memberCount",
         (SELECT COUNT(*)::int FROM "access_points" access_point WHERE access_point."scope_ref" = 'team:' || $1 AND access_point."status" = 'enabled') AS "teamAccessCount",
         (SELECT COUNT(*)::int FROM "access_points" access_point WHERE access_point."scope_ref" = 'global:' AND access_point."status" = 'enabled') AS "inheritedAccessCount"`,
      [teamId],
    );
    if (!row) throw new Error("postgres_team_detail_counts_empty");
    return row;
  }

  async resolveEnabledPublicHost(hostname: string): Promise<InstancePublicHost | null> {
    const row = await this.one<InstancePublicHost>(
      `SELECT * FROM "instance_public_hosts" WHERE "hostname" = $1 AND "enabled" = 1 LIMIT 1`,
      [hostname],
    );
    return row ?? null;
  }

  async pagePublicHosts(page = 1, pageSize = PUBLIC_HOST_PAGE_SIZE): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePublicHosts"]>>> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new RelayError("invalid_pagination", "pageSize must be between 1 and 200", 400);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*) AS "count" FROM "instance_public_hosts"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_public_host_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.max(1, Math.min(page, totalPages));
    const items = await this.rows<InstancePublicHost>(
      `SELECT * FROM "instance_public_hosts"
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async getPublicHostRecord(id: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getPublicHostRecord"]>>> {
    return this.one<InstancePublicHost>(`SELECT * FROM "instance_public_hosts" WHERE "id" = $1`, [id]);
  }

  async findPublicHostRecordByHostname(hostname: string): Promise<Awaited<ReturnType<ApplicationOperationPort["findPublicHostRecordByHostname"]>>> {
    return this.one<InstancePublicHost>(`SELECT * FROM "instance_public_hosts" WHERE "hostname" = $1 LIMIT 1`, [hostname]);
  }

  async hasDomainBindingHostname(hostname: string): Promise<boolean> {
    const row = await this.one<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM "domain_bindings" WHERE "hostname" = $1) AS "exists"`, [hostname]);
    return row?.exists === true;
  }

  async createPublicHostRecord(row: InstancePublicHost): Promise<InstancePublicHost> {
    return this.insertRow<InstancePublicHost>("instance_public_hosts", { ...row });
  }

  async updatePublicHostRecord(input: { id: string; enabled: boolean; updatedByUserId: string; updatedAt: string }): Promise<Awaited<ReturnType<ApplicationOperationPort["updatePublicHostRecord"]>>> {
    const result = await this.query<InstancePublicHost>(
      `UPDATE "instance_public_hosts"
       SET "enabled" = $1, "updated_by_user_id" = $2, "updated_at" = $3
       WHERE "id" = $4 RETURNING *`,
      [input.enabled ? 1 : 0, input.updatedByUserId, input.updatedAt, input.id],
    );
    return result.rows[0] ? mapPostgresRow<InstancePublicHost>(result.rows[0]) : undefined;
  }

  async deletePublicHostRecord(id: string): Promise<boolean> {
    const result = await this.query(`DELETE FROM "instance_public_hosts" WHERE "id" = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }

  async resolveActiveDomainBinding(hostname: string): Promise<ActiveDomainBinding | null> {
    const row = await this.one<ActiveDomainBinding & { teamIds?: string[] }>(
      `SELECT binding.*,
              COALESCE(array_agg(binding_team."team_id" ORDER BY binding_team."team_id")
                FILTER (WHERE binding_team."team_id" IS NOT NULL), ARRAY[]::text[]) AS "team_ids"
       FROM "domain_bindings" binding
       LEFT JOIN "domain_binding_teams" binding_team
         ON binding_team."domain_binding_id" = binding."id"
       WHERE binding."hostname" = $1 AND binding."status" = 'active'
       GROUP BY binding."id"
       LIMIT 1`,
      [hostname],
    );
    if (!row) return null;
    return { ...row, teamIds: row.teamIds ?? [] };
  }

  async pageEnabledServiceProducts(input: ServiceProductDirectoryInput = {}): Promise<PageResult<ServiceProductDirectoryRow>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "service_products"
       WHERE "status" = 'enabled'
         AND ($1 = '' OR position($1 IN lower("id" || ' ' || "code" || ' ' || "display_name" || ' ' || "fulfillment_effect")) > 0)`,
      [query],
    ))?.count ?? 0, "postgres_service_product_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const products = await this.rows<Omit<ServiceProductDirectoryRow, "listings" | "listingTotal" | "listingHasMore">>(
      `SELECT "id", "code", "version", "display_name" AS "displayName", "description",
              "fulfillment_effect" AS "fulfillmentEffect", "duration_seconds" AS "durationSeconds"
       FROM "service_products"
       WHERE "status" = 'enabled'
         AND ($1 = '' OR position($1 IN lower("id" || ' ' || "code" || ' ' || "display_name" || ' ' || "fulfillment_effect")) > 0)
       ORDER BY lower("code") ASC, "version" DESC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, (page - 1) * pageSize],
    );
    const productIds = products.map((product) => product.id);
    const listingRows = productIds.length === 0
      ? []
      : await this.rows<{
        productId: string;
        id: string;
        priceAmountUnits: number;
        paymentChannelId: string;
        paymentChannelDisplayName: string;
        paymentNetwork: string;
        paymentAsset: string;
        recipientIdentifierType: string;
        recipientIdentifierDisplay: string;
        paymentInstruction: string | null;
        listingPosition: number;
        listingTotal: number;
      }>(
        `WITH ranked AS (
           SELECT listing."product_id" AS "productId", listing."id",
                  listing."price_amount_units" AS "priceAmountUnits",
                  channel."id" AS "paymentChannelId",
                  channel."display_name" AS "paymentChannelDisplayName",
                  channel."payment_network" AS "paymentNetwork",
                  channel."payment_asset" AS "paymentAsset",
                  channel."recipient_identifier_type" AS "recipientIdentifierType",
                  channel."recipient_identifier_display" AS "recipientIdentifierDisplay",
                  channel."payment_instruction" AS "paymentInstruction",
                  ROW_NUMBER() OVER (PARTITION BY listing."product_id" ORDER BY listing."created_at" ASC, listing."id" ASC) AS "listingPosition",
                  COUNT(*) OVER (PARTITION BY listing."product_id")::int AS "listingTotal"
           FROM "service_product_listings" listing
           INNER JOIN "payment_channels" channel
             ON channel."id" = listing."payment_channel_id" AND channel."status" = 'enabled'
           WHERE listing."status" = 'enabled' AND listing."product_id" = ANY($1::text[])
         )
         SELECT * FROM ranked
         WHERE "listingPosition" <= 20
         ORDER BY "productId" ASC, "listingPosition" ASC, "id" ASC`,
        [productIds],
      );
    const listingsByProduct = new Map<string, { items: ServiceProductListingProjection[]; total: number }>();
    for (const row of listingRows) {
      const current = listingsByProduct.get(row.productId) ?? { items: [], total: row.listingTotal };
      current.items.push({
        id: row.id,
        priceAmountUnits: row.priceAmountUnits,
        paymentChannel: {
          id: row.paymentChannelId,
          displayName: row.paymentChannelDisplayName,
          paymentNetwork: row.paymentNetwork,
          paymentAsset: row.paymentAsset,
          recipientIdentifierType: row.recipientIdentifierType,
          recipientIdentifierDisplay: row.recipientIdentifierDisplay,
          paymentInstruction: row.paymentInstruction,
        },
      });
      listingsByProduct.set(row.productId, current);
    }
    return {
      items: products.map((product) => {
        const related = listingsByProduct.get(product.id) ?? { items: [], total: 0 };
        return { ...product, listings: related.items, listingTotal: related.total, listingHasMore: related.total > related.items.length };
      }),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  async listServiceProducts(): Promise<ServiceProduct[]> {
    return this.rows<ServiceProduct>(`SELECT * FROM "service_products" ORDER BY "code" ASC, "version" ASC`);
  }

  async createServiceProduct(input: {
    code: string;
    displayName: string;
    description?: string | null;
    fulfillmentEffect: "partner_team_annual";
    durationSeconds?: number | null;
    partnerPlanId?: string | null;
    createdByUserId: string;
  }): Promise<ServiceProduct> {
    const code = postgresRequiredTrimmed(input.code, "code", 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(code)) throw new RelayError("service_product_code_invalid", "Service product code contains unsupported characters", 400);
    const displayName = postgresRequiredTrimmed(input.displayName, "displayName", 120);
    if (input.fulfillmentEffect !== "partner_team_annual") throw new RelayError("service_product_effect_invalid", "Unsupported service product fulfillment effect", 400);
    if (!(await this.getUser(input.createdByUserId))) throw new RelayError("user_not_found", "Product creator not found", 404);
    const durationSeconds = Number(input.durationSeconds);
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new RelayError("invalid_service_commerce_input", "durationSeconds must be a positive safe integer", 400);
    const partnerPlanId = postgresRequiredTrimmed(input.partnerPlanId, "partnerPlanId", 200);
    await this.assertPostgresPartnerPlanAvailable(partnerPlanId);
    const version = safePostgresInteger((await this.one<{ version: number }>(
      `SELECT COALESCE(MAX("version"), 0) + 1 AS "version" FROM "service_products" WHERE "code" = $1`,
      [code],
    ))?.version ?? 1, "postgres_service_product_version_invalid");
    const row = await this.insertRow<ServiceProduct>("service_products", {
      id: createId("service_product"),
      code,
      version,
      displayName,
      description: postgresTrimNullable(input.description),
      fulfillmentEffect: input.fulfillmentEffect,
      durationSeconds,
      partnerPlanId,
      status: "enabled",
      createdByUserId: input.createdByUserId,
      createdAt: nowIso(),
    });
    await this.audit({
      actor: { actorType: "user", actorId: input.createdByUserId },
      action: "service_product.create",
      resource: { resourceType: "service_product", resourceId: row.id },
      result: "success",
      source: "owner",
      metadata: { code: row.code, version: row.version, fulfillmentEffect: row.fulfillmentEffect, status: row.status },
    });
    return row;
  }

  async updateServiceProductStatus(id: string, status: "enabled" | "disabled", actorUserId: string): Promise<ServiceProduct> {
    const existing = await this.getServiceProduct(id);
    if (!existing) throw new RelayError("service_product_not_found", "Service product not found", 404);
    if (status === "enabled") await this.assertPostgresPartnerPlanAvailable(existing.partnerPlanId);
    const updated = await this.updateRow<ServiceProduct>("service_products", id, { status });
    if (!updated) throw new RelayError("service_product_not_found", "Service product not found", 404);
    await this.audit({
      actor: { actorType: "user", actorId: actorUserId },
      action: "service_product.status_update",
      resource: { resourceType: "service_product", resourceId: id },
      result: "success",
      source: "owner",
      metadata: { previousStatus: existing.status, status },
    });
    return updated;
  }

  async listServiceProductListings(productId?: string): Promise<ServiceProductListing[]> {
    return this.rows<ServiceProductListing>(
      `SELECT * FROM "service_product_listings" ${productId ? "WHERE \"product_id\" = $1" : ""} ORDER BY "created_at" ASC, "id" ASC`,
      productId ? [productId] : [],
    );
  }

  async createServiceProductListing(input: { productId: string; paymentChannelId: string; priceAmountUnits: number; createdByUserId: string }): Promise<ServiceProductListing> {
    const product = await this.getServiceProduct(input.productId);
    if (!product) throw new RelayError("service_product_not_found", "Service product not found", 404);
    if (product.status !== "enabled") throw new RelayError("service_product_not_enabled", "Service product is not enabled", 409);
    const channel = await this.getPaymentChannel(input.paymentChannelId);
    if (!channel) throw new RelayError("payment_channel_not_found", "Payment channel not found", 404);
    if (channel.status !== "enabled" || channel.settlementMode !== "manual_review") throw new RelayError("payment_channel_not_enabled", "An enabled manual-review payment channel is required", 409);
    const priceAmountUnits = postgresRequiredPaymentUnits(input.priceAmountUnits, channel.paymentAsset, "priceAmountUnits");
    const row = {
      id: createId("service_listing"),
      productId: product.id,
      paymentChannelId: channel.id,
      priceAmountUnits,
      status: "enabled",
      createdAt: nowIso(),
    } as const;
    try {
      const inserted = await this.insertRow<ServiceProductListing>("service_product_listings", row);
      await this.audit({
        actor: { actorType: "user", actorId: input.createdByUserId },
        action: "service_product_listing.create",
        resource: { resourceType: "service_product_listing", resourceId: inserted.id },
        result: "success",
        source: "owner",
        metadata: { productId: inserted.productId, paymentChannelId: inserted.paymentChannelId, priceAmountUnits: inserted.priceAmountUnits, status: inserted.status },
      });
      return inserted;
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new RelayError("service_product_listing_already_enabled", "An enabled listing already exists for this product and payment channel", 409);
      throw error;
    }
  }

  async updateServiceProductListingStatus(id: string, status: "enabled" | "disabled", actorUserId: string): Promise<ServiceProductListing> {
    const existing = await this.getServiceProductListing(id);
    if (!existing) throw new RelayError("service_product_listing_not_found", "Service product listing not found", 404);
    const updated = await this.updateRow<ServiceProductListing>("service_product_listings", id, { status });
    if (!updated) throw new RelayError("service_product_listing_not_found", "Service product listing not found", 404);
    await this.audit({
      actor: { actorType: "user", actorId: actorUserId },
      action: "service_product_listing.status_update",
      resource: { resourceType: "service_product_listing", resourceId: id },
      result: "success",
      source: "owner",
      metadata: { previousStatus: existing.status, status },
    });
    return updated;
  }

  async getServiceProduct(id: string): Promise<ServiceProduct | undefined> {
    return this.one<ServiceProduct>(`SELECT * FROM "service_products" WHERE "id" = $1`, [id]);
  }

  async getServiceProductListing(id: string): Promise<ServiceProductListing | undefined> {
    return this.one<ServiceProductListing>(`SELECT * FROM "service_product_listings" WHERE "id" = $1`, [id]);
  }

  async getServiceOrder(id: string): Promise<ServiceOrder | undefined> {
    return this.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1`, [id]);
  }

  async listServiceOrdersForBuyer(buyerUserId: string): Promise<ServiceOrder[]> {
    return this.rows<ServiceOrder>(
      `SELECT * FROM "service_orders" WHERE "buyer_user_id" = $1 ORDER BY "created_at" DESC, "id" DESC`,
      [buyerUserId],
    );
  }

  async listServiceOrders(): Promise<ServiceOrder[]> {
    return this.rows<ServiceOrder>(`SELECT * FROM "service_orders" ORDER BY "created_at" DESC, "id" DESC`);
  }

  async listServiceFulfillments(): Promise<ServiceFulfillment[]> {
    return this.rows<ServiceFulfillment>(`SELECT * FROM "service_fulfillments" ORDER BY "created_at" DESC, "id" DESC`);
  }

  async createServiceOrder(input: {
    buyerUserId: string;
    productListingId: string;
    purchaseIntent: "new" | "renew";
    targetPartnerTeamId?: string | null;
    idempotencyKey: string;
  }): Promise<ServiceOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const buyer = await transaction.getUser(input.buyerUserId);
      if (!buyer || buyer.status !== "enabled") throw new RelayError("user_not_found", "Enabled buyer not found", 404);
      const listing = await transaction.getServiceProductListing(input.productListingId);
      if (!listing || listing.status !== "enabled") throw new RelayError("service_product_listing_not_enabled", "Service product listing is not enabled", 409);
      const product = await transaction.getServiceProduct(listing.productId);
      const channel = await transaction.getPaymentChannel(listing.paymentChannelId);
      if (!product || product.status !== "enabled" || !channel || channel.status !== "enabled" || channel.settlementMode !== "manual_review") {
        throw new RelayError("service_product_configuration_unavailable", "Service product configuration is unavailable", 409);
      }
      const partnerPlan = await transaction.getPlan(product.partnerPlanId);
      if (!partnerPlan || partnerPlan.planStatus !== "enabled") throw new RelayError("partner_plan_unavailable", "Partner Plan is not available", 409);
      const targetPartnerTeamId = input.targetPartnerTeamId ?? null;
      if (input.purchaseIntent !== "new" && input.purchaseIntent !== "renew") throw new RelayError("service_purchase_intent_invalid", "purchaseIntent must be new or renew", 400);
      if (input.purchaseIntent === "new" && targetPartnerTeamId) throw new RelayError("service_purchase_target_invalid", "A new Partner Team order cannot specify a target Team", 400);
      if (input.purchaseIntent === "renew" && !targetPartnerTeamId) throw new RelayError("service_purchase_target_required", "A renewal order must specify a target Partner Team", 400);
      if (targetPartnerTeamId) {
        const team = await transaction.getTeam(targetPartnerTeamId);
        if (!team || team.status !== "enabled" || team.ownerId !== input.buyerUserId) throw new RelayError("partner_team_not_found", "Renewal target is not an enabled Team owned by the buyer", 404);
      }
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ productListingId: listing.id, purchaseIntent: input.purchaseIntent, targetPartnerTeamId }));
      const now = nowIso();
      const row = {
        id: createId("service_order"),
        buyerUserId: input.buyerUserId,
        targetPartnerTeamId,
        productId: product.id,
        productListingId: listing.id,
        paymentChannelId: channel.id,
        productCode: product.code,
        productVersion: product.version,
        productDisplayName: product.displayName,
        fulfillmentEffect: product.fulfillmentEffect,
        durationSeconds: product.durationSeconds,
        partnerPlanId: product.partnerPlanId,
        purchaseIntent: input.purchaseIntent,
        expectedPaymentAmountUnits: listing.priceAmountUnits,
        confirmedReceivedAmountUnits: null,
        paymentAsset: channel.paymentAsset,
        paymentNetwork: channel.paymentNetwork,
        normalizedTransactionReferenceHash: null,
        transactionReferenceTail: null,
        paymentSubmittedAt: null,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewNote: null,
        status: "pending_payment",
        createIdempotencyKeyHash: idempotencyKeyHash,
        createRequestHash: requestHash,
        createdAt: now,
        updatedAt: now,
      } satisfies Record<string, unknown>;
      const inserted = await transaction.query<ServiceOrder>(
        `INSERT INTO "service_orders" (
           "id", "buyer_user_id", "target_partner_team_id", "product_id", "product_listing_id", "payment_channel_id",
           "product_code", "product_version", "product_display_name", "fulfillment_effect", "duration_seconds", "partner_plan_id",
           "purchase_intent", "expected_payment_amount_units", "confirmed_received_amount_units", "payment_asset", "payment_network",
           "normalized_transaction_reference_hash", "transaction_reference_tail", "payment_submitted_at", "reviewed_by_user_id",
           "reviewed_at", "review_note", "status", "create_idempotency_key_hash", "create_request_hash", "created_at", "updated_at"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
         ON CONFLICT ("buyer_user_id", "create_idempotency_key_hash") DO NOTHING
         RETURNING *`,
        [
          row.id, row.buyerUserId, row.targetPartnerTeamId, row.productId, row.productListingId, row.paymentChannelId,
          row.productCode, row.productVersion, row.productDisplayName, row.fulfillmentEffect, row.durationSeconds, row.partnerPlanId,
          row.purchaseIntent, row.expectedPaymentAmountUnits, row.confirmedReceivedAmountUnits, row.paymentAsset, row.paymentNetwork,
          row.normalizedTransactionReferenceHash, row.transactionReferenceTail, row.paymentSubmittedAt, row.reviewedByUserId,
          row.reviewedAt, row.reviewNote, row.status, row.createIdempotencyKeyHash, row.createRequestHash, row.createdAt, row.updatedAt,
        ],
      );
      if (inserted.rows[0]) {
        const created = mapPostgresRow<ServiceOrder>(inserted.rows[0]);
        await transaction.audit({ actor: { actorType: "user", actorId: input.buyerUserId }, action: "service_order.create", resource: { resourceType: "service_order", resourceId: created.id }, result: "success", source: "web", metadata: { productId: created.productId, productListingId: created.productListingId, purchaseIntent: created.purchaseIntent, targetPartnerTeamId: created.targetPartnerTeamId, expectedPaymentAmountUnits: created.expectedPaymentAmountUnits, paymentAsset: created.paymentAsset } });
        return created;
      }
      const existing = await transaction.one<ServiceOrder>(
        `SELECT * FROM "service_orders" WHERE "buyer_user_id" = $1 AND "create_idempotency_key_hash" = $2 FOR UPDATE`,
        [input.buyerUserId, idempotencyKeyHash],
      );
      if (!existing) throw new Error("postgres_service_order_idempotency_readback_empty");
      if (existing.createRequestHash !== requestHash) throw new RelayError("idempotency_conflict", "Idempotency key was already used with a different service order", 409);
      return existing;
    });
  }

  async submitServiceOrderPayment(input: { orderId: string; buyerUserId: string; transactionReference: string }): Promise<ServiceOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]);
      if (!order || order.buyerUserId !== input.buyerUserId) throw new RelayError("service_order_not_found", "Service order not found", 404);
      if (order.status !== "pending_payment") throw new RelayError("service_order_not_pending_payment", "Only pending service orders accept payment evidence", 409);
      const transactionReference = postgresRequiredTrimmed(input.transactionReference, "transactionReference");
      const normalizedTransactionReferenceHash = postgresSha256Text(postgresNormalizePaymentIdentifier(transactionReference));
      postgresRejectSensitivePaymentIdentifier(transactionReference);
      const duplicate = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "service_orders" WHERE "payment_network" = $1 AND "normalized_transaction_reference_hash" = $2 LIMIT 1`,
        [order.paymentNetwork, normalizedTransactionReferenceHash],
      );
      if (duplicate) throw new RelayError("duplicate_transaction_reference", "This payment transaction reference has already been used", 409);
      const now = nowIso();
      const updated = await transaction.query<ServiceOrder>(
        `UPDATE "service_orders"
         SET "normalized_transaction_reference_hash" = $2, "transaction_reference_tail" = $3,
             "payment_submitted_at" = $4, "status" = 'pending_review', "updated_at" = $4
         WHERE "id" = $1 AND "status" = 'pending_payment'
         RETURNING *`,
        [order.id, normalizedTransactionReferenceHash, transactionReference.slice(-8), now],
      );
      if (!updated.rows[0]) throw new RelayError("service_order_not_pending_payment", "Only pending service orders accept payment evidence", 409);
      const result = mapPostgresRow<ServiceOrder>(updated.rows[0]);
      await transaction.audit({ actor: { actorType: "user", actorId: input.buyerUserId }, action: "service_order.payment_submit", resource: { resourceType: "service_order", resourceId: result.id }, result: "success", source: "web", metadata: { paymentNetwork: result.paymentNetwork, transactionReferenceTail: result.transactionReferenceTail } });
      return result;
    });
  }

  async cancelServiceOrder(input: { orderId: string; buyerUserId: string }): Promise<ServiceOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]);
      if (!order || order.buyerUserId !== input.buyerUserId) throw new RelayError("service_order_not_found", "Service order not found", 404);
      if (order.status === "cancelled") return order;
      if (order.status !== "pending_payment" && order.status !== "pending_review") throw new RelayError("service_order_not_cancellable", "Only unpaid or unreviewed service orders can be cancelled", 409);
      const now = nowIso();
      const updated = await transaction.query<ServiceOrder>(
        `UPDATE "service_orders" SET "status" = 'cancelled', "updated_at" = $2 WHERE "id" = $1 RETURNING *`,
        [order.id, now],
      );
      if (!updated.rows[0]) throw new RelayError("service_order_not_found", "Service order not found", 404);
      const result = mapPostgresRow<ServiceOrder>(updated.rows[0]);
      await transaction.audit({ actor: { actorType: "user", actorId: input.buyerUserId }, action: "service_order.cancel", resource: { resourceType: "service_order", resourceId: result.id }, result: "success", source: "web", metadata: { previousStatus: order.status, status: result.status } });
      return result;
    });
  }

  async approveServiceOrder(input: { orderId: string; ownerUserId: string; confirmedReceivedAmountUnits: number; reviewNote: string }): Promise<{ order: ServiceOrder; fulfillment: ServiceFulfillment }> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]);
      if (!order) throw new RelayError("service_order_not_found", "Service order not found", 404);
      const existingFulfillment = await transaction.one<ServiceFulfillment>(
        `SELECT * FROM "service_fulfillments" WHERE "order_id" = $1 AND "effect_type" = $2 FOR UPDATE`,
        [order.id, order.fulfillmentEffect],
      );
      if ((order.status === "paid" || order.status === "fulfilled") && existingFulfillment) return { order, fulfillment: existingFulfillment };
      if (order.status !== "pending_review" || !order.paymentSubmittedAt) throw new RelayError("service_order_not_pending_review", "Only submitted service orders can be approved", 409);
      const confirmedReceivedAmountUnits = postgresRequiredPositiveInteger(input.confirmedReceivedAmountUnits, "confirmedReceivedAmountUnits");
      const reviewNote = postgresRequiredTrimmed(input.reviewNote, "reviewNote", 1000);
      const now = nowIso();
      const updated = await transaction.query<ServiceOrder>(
        `UPDATE "service_orders"
         SET "status" = 'paid', "confirmed_received_amount_units" = $2,
             "reviewed_by_user_id" = $3, "reviewed_at" = $4, "review_note" = $5, "updated_at" = $4
         WHERE "id" = $1 AND "status" = 'pending_review'
         RETURNING *`,
        [order.id, confirmedReceivedAmountUnits, input.ownerUserId, now, reviewNote],
      );
      if (!updated.rows[0]) throw new RelayError("service_order_not_pending_review", "Only submitted service orders can be approved", 409);
      const paidOrder = mapPostgresRow<ServiceOrder>(updated.rows[0]);
      const fulfillment = await transaction.insertRow<ServiceFulfillment>("service_fulfillments", {
        id: createId("service_fulfillment"), orderId: paidOrder.id, effectType: paidOrder.fulfillmentEffect,
        targetType: null, targetId: null, status: "pending", initiatedByUserId: paidOrder.buyerUserId,
        completedByUserId: null, errorCode: null, createdAt: now, completedAt: null, updatedAt: now,
      });
      await transaction.audit({
        actor: { actorType: "user", actorId: input.ownerUserId },
        action: "service_order.approve",
        resource: { resourceType: "service_order", resourceId: order.id },
        result: "success",
        source: "owner",
        metadata: { fulfillmentId: fulfillment.id, fulfillmentEffect: fulfillment.effectType, orderStatus: "paid", fulfillmentStatus: "pending" },
      });
      return { order: paidOrder, fulfillment };
    });
  }

  async retryServiceOrderFulfillment(input: { orderId: string; ownerUserId: string }): Promise<{ order: ServiceOrder; fulfillment: ServiceFulfillment }> {
    try {
      return await this.withRetriedTransaction(async (transaction) => {
        const order = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]);
        if (!order) throw new RelayError("service_order_not_found", "Service order not found", 404);
        const fulfillment = await transaction.one<ServiceFulfillment>(
          `SELECT * FROM "service_fulfillments" WHERE "order_id" = $1 AND "effect_type" = $2 FOR UPDATE`,
          [order.id, order.fulfillmentEffect],
        );
        if (!fulfillment) throw new RelayError("service_fulfillment_not_found", "Paid service order has no fulfillment", 409);
        if (order.status === "fulfilled" && fulfillment.status === "fulfilled") return { order, fulfillment };
        if (order.status !== "paid" || !["pending", "blocked"].includes(fulfillment.status)) {
          throw new RelayError("service_fulfillment_not_retryable", "Service fulfillment is not explicitly retryable", 409);
        }
        const at = nowIso();
        await transaction.query(
          `UPDATE "service_fulfillments" SET "status" = 'ready', "error_code" = NULL, "updated_at" = $2 WHERE "id" = $1`,
          [fulfillment.id, at],
        );
        const completed = await transaction.fulfillPostgresServiceOrder(order, fulfillment.id, input.ownerUserId, at);
        const completedOrder = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1`, [order.id]);
        if (!completedOrder) throw new Error("postgres_service_order_fulfillment_readback_empty");
        await transaction.audit({
          actor: { actorType: "user", actorId: input.ownerUserId }, action: "service_order.fulfillment_retry",
          resource: { resourceType: "service_order", resourceId: order.id }, result: "success", source: "owner",
          metadata: { fulfillmentId: completed.id, fulfillmentEffect: completed.effectType, targetType: completed.targetType, targetId: completed.targetId },
        });
        return { order: completedOrder, fulfillment: completed };
      });
    } catch (error) {
      if (error instanceof RelayError && ["service_order_not_found", "service_fulfillment_not_found", "service_fulfillment_not_retryable"].includes(error.code)) throw error;
      const errorCode = error instanceof RelayError ? error.code : "service_fulfillment_failed";
      await this.withRetriedTransaction(async (transaction) => {
        const order = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]);
        if (!order || order.status !== "paid") return;
        const at = nowIso();
        await transaction.query(
          `UPDATE "service_fulfillments" SET "status" = 'blocked', "error_code" = $2, "updated_at" = $3
           WHERE "order_id" = $1 AND "status" IN ('pending','ready','blocked')`,
          [order.id, errorCode, at],
        );
        await transaction.audit({
          actor: { actorType: "user", actorId: input.ownerUserId }, action: "service_order.fulfillment_blocked",
          resource: { resourceType: "service_order", resourceId: order.id }, result: "failure", source: "owner",
          metadata: { errorCode },
        });
      });
      throw new RelayError("service_fulfillment_blocked", "Payment remains recorded, but fulfillment is blocked and requires an explicit retry", 409, { errorCode });
    }
  }

  async rejectServiceOrder(input: { orderId: string; ownerUserId: string; reviewNote: string }): Promise<ServiceOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.one<ServiceOrder>(`SELECT * FROM "service_orders" WHERE "id" = $1 FOR UPDATE`, [input.orderId]);
      if (!order) throw new RelayError("service_order_not_found", "Service order not found", 404);
      if (order.status === "rejected") return order;
      if (order.status !== "pending_review" || !order.paymentSubmittedAt) throw new RelayError("service_order_not_pending_review", "Only submitted service orders can be rejected", 409);
      const now = nowIso();
      const updated = await transaction.query<ServiceOrder>(
        `UPDATE "service_orders"
         SET "status" = 'rejected', "reviewed_by_user_id" = $2, "reviewed_at" = $3,
             "review_note" = $4, "updated_at" = $3
         WHERE "id" = $1 AND "status" = 'pending_review'
         RETURNING *`,
        [order.id, input.ownerUserId, now, postgresRequiredTrimmed(input.reviewNote, "reviewNote", 1000)],
      );
      if (!updated.rows[0]) throw new RelayError("service_order_not_pending_review", "Only submitted service orders can be rejected", 409);
      const result = mapPostgresRow<ServiceOrder>(updated.rows[0]);
      await transaction.audit({
        actor: { actorType: "user", actorId: input.ownerUserId },
        action: "service_order.reject",
        resource: { resourceType: "service_order", resourceId: order.id },
        result: "success",
        source: "owner",
        metadata: { previousStatus: order.status, status: result.status },
      });
      return result;
    });
  }

  async getPartnerTeamCreationAllocation(id: string): Promise<PartnerTeamCreationAllocation | undefined> {
    return this.one<PartnerTeamCreationAllocation>(`SELECT * FROM "partner_team_creation_allocations" WHERE "id" = $1`, [id]);
  }

  async listAvailablePartnerTeamCreationAllocations(ownerUserId: string): Promise<PartnerTeamCreationAllocation[]> {
    return this.rows<PartnerTeamCreationAllocation>(
      `SELECT * FROM "partner_team_creation_allocations"
       WHERE "owner_user_id" = $1 AND "consumed_team_id" IS NULL
       ORDER BY "created_at" ASC, "id" ASC`,
      [ownerUserId],
    );
  }

  async consumePartnerTeamCreationAllocation(input: { allocationId: string; ownerUserId: string; teamName: string; at?: string; source?: AuditSource }): Promise<{ allocation: PartnerTeamCreationAllocation; entitlement: PartnerOperatingEntitlement; teamId: string }> {
    return this.withRetriedTransaction(async (transaction) => {
      const allocation = await transaction.one<PartnerTeamCreationAllocation>(
        `SELECT * FROM "partner_team_creation_allocations" WHERE "id" = $1 AND "owner_user_id" = $2 FOR UPDATE`,
        [input.allocationId, input.ownerUserId],
      );
      if (!allocation) throw new RelayError("partner_team_allocation_not_found", "Partner Team creation allocation not found", 404);
      if (allocation.consumedTeamId) {
        const entitlement = await transaction.one<PartnerOperatingEntitlement>(`SELECT * FROM "partner_operating_entitlements" WHERE "source_order_id" = $1`, [allocation.sourceOrderId]);
        if (!entitlement) throw new RelayError("partner_entitlement_missing", "Consumed Partner Team allocation has no operating entitlement", 500);
        return { allocation, entitlement, teamId: allocation.consumedTeamId };
      }
      const teamName = postgresRequiredTrimmed(input.teamName, "teamName", 120);
      const at = input.at ?? nowIso();
      if (!Number.isFinite(Date.parse(at))) throw new RelayError("invalid_timestamp", "Timestamp arithmetic input is invalid", 400);
      const team = await transaction.upsertTeam({ name: teamName, ownerId: input.ownerUserId, teamOwnerCanCreateCustomProvider: 0, teamOwnerCanCreateAccessPoint: 1 });
      await transaction.grantTeamMembership(team.id, input.ownerUserId);
      const effectiveEnd = postgresAddSeconds(at, allocation.durationSeconds);
      const subscription = await transaction.createPlanSubscription({ planId: allocation.partnerPlanId, scopeRef: teamScopeRef(team.id), purchasedByUserId: input.ownerUserId, source: "partner_annual", priority: 10, effectiveStart: at, effectiveEnd });
      const entitlement = await transaction.insertRow<PartnerOperatingEntitlement>("partner_operating_entitlements", {
        id: createId("partner_entitlement"), sourceOrderId: allocation.sourceOrderId, ownerUserId: input.ownerUserId,
        partnerTeamId: team.id, partnerPlanId: allocation.partnerPlanId, planSubscriptionId: subscription.id,
        effectiveStart: at, effectiveEnd, lifecycle: "active", createdAt: nowIso(),
      });
      const consumed = await transaction.query<PartnerTeamCreationAllocation>(
        `UPDATE "partner_team_creation_allocations"
         SET "consumed_team_id" = $2, "consumed_at" = $3
         WHERE "id" = $1 AND "owner_user_id" = $4 AND "consumed_team_id" IS NULL
         RETURNING *`,
        [allocation.id, team.id, at, input.ownerUserId],
      );
      if (!consumed.rows[0]) throw new RelayError("partner_team_allocation_already_consumed", "Partner Team creation allocation was already consumed", 409);
      await transaction.audit({ actor: { actorType: "user", actorId: input.ownerUserId }, action: "partner_team.create", resource: { resourceType: "team", resourceId: team.id }, result: "success", source: input.source ?? "web", metadata: { allocationId: allocation.id, sourceOrderId: allocation.sourceOrderId, entitlementId: entitlement.id, planSubscriptionId: entitlement.planSubscriptionId } });
      return { allocation: mapPostgresRow<PartnerTeamCreationAllocation>(consumed.rows[0]), entitlement, teamId: team.id };
    });
  }

  async listDomainBindingsForOwner(ownerUserId: string): Promise<DomainBinding[]> {
    return this.rows<DomainBinding>(postgresDomainBindingSelect(`WHERE "owner_user_id" = $1`), [ownerUserId]);
  }

  async listDomainBindings(): Promise<DomainBinding[]> {
    return this.rows<DomainBinding>(postgresDomainBindingSelect(), []);
  }

  async getDomainBinding(id: string): Promise<DomainBinding | undefined> {
    return this.one<DomainBinding>(postgresDomainBindingSelect(`WHERE "id" = $1`), [id]);
  }

  async grantDomainBindingSlot(input: { orderId: string; actorUserId: string }): Promise<{ id: string; ownerUserId: string }> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.one<{ id: string; buyerUserId: string; status: string }>(
        `SELECT "id", "buyer_user_id" AS "buyerUserId", "status" FROM "service_orders" WHERE "id" = $1 FOR UPDATE`,
        [input.orderId],
      );
      if (!order || order.status !== "fulfilled") throw new RelayError("domain_binding_order_not_fulfilled", "A fulfilled service order is required", 409);
      const id = createId("domain_slot");
      try {
        await transaction.insertRow("domain_binding_slots", {
          id,
          ownerUserId: order.buyerUserId,
          sourceOrderId: order.id,
          status: "available",
          consumedByBindingId: null,
          createdAt: nowIso(),
          consumedAt: null,
        });
      } catch (error) {
        if (isPostgresUniqueViolation(error)) throw new RelayError("domain_binding_slot_already_granted", "This order already granted a slot", 409);
        throw error;
      }
      await transaction.upsertResourcePermission({ resourceType: "user", resourceId: order.buyerUserId, action: "user.domain_binding.manage", subjectType: "user", subjectRef: order.buyerUserId, status: "enabled" });
      await transaction.audit({ actor: { actorType: "user", actorId: input.actorUserId }, action: "domain_binding.slot_grant", resource: { resourceType: "domain_binding_slot", resourceId: id }, result: "success", source: "owner", metadata: { ownerUserId: order.buyerUserId, sourceOrderId: order.id } });
      return { id, ownerUserId: order.buyerUserId };
    });
  }

  async verifyDomainBinding(id: string, actorUserId: string): Promise<DomainBinding> {
    const binding = await this.getDomainBinding(id);
    if (!binding) throw new RelayError("domain_binding_not_found", "Domain binding not found", 404);
    if (binding.status !== "pending_verification") throw new RelayError("domain_binding_not_pending_verification", "Only pending bindings can be verified", 409);
    const token = await this.one<{ tokenHash: string }>(`SELECT "verification_token_hash" AS "tokenHash" FROM "domain_bindings" WHERE "id" = $1`, [id]);
    if (!token) throw new RelayError("domain_binding_not_found", "Domain binding not found", 404);
    const records = await new Resolver().resolveTxt(`_friday-relay-verify.${binding.hostname}`).catch(() => [] as string[][]);
    if (!records.some((record) => postgresSha256Text(record.join("")) === token.tokenHash)) throw new RelayError("domain_binding_dns_verification_failed", "Expected DNS TXT proof was not found", 409);
    const now = nowIso();
    const result = await this.query<DomainBinding>(
      `UPDATE "domain_bindings" SET "status" = 'verified', "verified_at" = $2, "verified_by_user_id" = $3, "updated_at" = $2 WHERE "id" = $1 AND "status" = 'pending_verification' RETURNING *`,
      [id, now, actorUserId],
    );
    if (!result.rows[0]) throw new RelayError("domain_binding_not_pending_verification", "Only pending bindings can be verified", 409);
    const updated = mapPostgresRow<DomainBinding>(result.rows[0]);
    await this.audit({ actor: { actorType: "user", actorId: actorUserId }, action: "domain_binding.verify", resource: { resourceType: "domain_binding", resourceId: id }, result: "success", source: "owner", metadata: { hostname: binding.hostname, method: "dns_txt" } });
    return updated;
  }

  async activateDomainBinding(input: { id: string; actorUserId: string; registrationInviteLinkId: string }): Promise<DomainBinding> {
    return this.withRetriedTransaction(async (transaction) => {
      const binding = await transaction.getDomainBinding(input.id);
      if (!binding) throw new RelayError("domain_binding_not_found", "Domain binding not found", 404);
      if (binding.status !== "verified") throw new RelayError("domain_binding_not_verified", "Only verified bindings can be activated", 409);
      const teamIds = await transaction.rows<{ teamId: string }>(`SELECT "team_id" AS "teamId" FROM "domain_binding_teams" WHERE "domain_binding_id" = $1 ORDER BY "team_id"`, [binding.id]);
      if (!binding.defaultRegistrationTeamId || !teamIds.some((row) => row.teamId === binding.defaultRegistrationTeamId)) throw new RelayError("domain_binding_default_team_invalid", "The default registration Team is unavailable", 409);
      const invite = await transaction.getTeamInviteLink(input.registrationInviteLinkId);
      if (!invite || invite.status !== "enabled" || invite.teamId !== binding.defaultRegistrationTeamId || invite.createdByUserId !== input.actorUserId) throw new RelayError("domain_binding_registration_invite_invalid", "An enabled Platform Owner invite for the default Team is required", 409);
      const now = nowIso();
      const consumed = await transaction.query(`UPDATE "domain_binding_slots" SET "status" = 'consumed', "consumed_by_binding_id" = $2, "consumed_at" = $3 WHERE "id" = $1 AND "status" = 'available'`, [binding.slotId, binding.id, now]);
      if (consumed.rowCount !== 1) throw new RelayError("domain_binding_slot_unavailable", "The domain binding slot is no longer available", 409);
      const result = await transaction.query<DomainBinding>(
        `UPDATE "domain_bindings" SET "status" = 'active', "registration_invite_link_id" = $2, "activated_at" = $3, "activated_by_user_id" = $4, "updated_at" = $3 WHERE "id" = $1 RETURNING *`,
        [binding.id, input.registrationInviteLinkId, now, input.actorUserId],
      );
      if (!result.rows[0]) throw new RelayError("domain_binding_not_found", "Domain binding not found", 404);
      const updated = mapPostgresRow<DomainBinding>(result.rows[0]);
      await transaction.audit({ actor: { actorType: "user", actorId: input.actorUserId }, action: "domain_binding.activate", resource: { resourceType: "domain_binding", resourceId: binding.id }, result: "success", source: "owner", metadata: { hostname: binding.hostname, defaultRegistrationTeamId: binding.defaultRegistrationTeamId, registrationInviteLinkId: input.registrationInviteLinkId } });
      return updated;
    });
  }

  async setDomainBindingStatus(id: string, actorUserId: string, status: "disabled" | "released"): Promise<DomainBinding> {
    return this.withRetriedTransaction(async (transaction) => {
      const binding = await transaction.getDomainBinding(id);
      if (!binding) throw new RelayError("domain_binding_not_found", "Domain binding not found", 404);
      if (binding.status === "released") throw new RelayError("domain_binding_released", "Released bindings cannot be changed", 409);
      const now = nowIso();
      const result = await transaction.query<DomainBinding>(
        status === "disabled"
          ? `UPDATE "domain_bindings" SET "status" = 'disabled', "disabled_at" = $2, "disabled_by_user_id" = $3, "updated_at" = $2 WHERE "id" = $1 RETURNING *`
          : `UPDATE "domain_bindings" SET "status" = 'released', "released_at" = $2, "released_by_user_id" = $3, "updated_at" = $2 WHERE "id" = $1 RETURNING *`,
        [id, now, actorUserId],
      );
      if (!result.rows[0]) throw new RelayError("domain_binding_not_found", "Domain binding not found", 404);
      const updated = mapPostgresRow<DomainBinding>(result.rows[0]);
      await transaction.audit({ actor: { actorType: "user", actorId: actorUserId }, action: `domain_binding.${status}`, resource: { resourceType: "domain_binding", resourceId: id }, result: "success", source: "owner", metadata: { hostname: binding.hostname } });
      return updated;
    });
  }

  async createDomainBinding(input: { ownerUserId: string; hostname: string; teamIds: string[]; defaultRegistrationTeamId: string }): Promise<{ binding: DomainBinding; verificationName: string; verificationValue: string }> {
    const hostname = normalizeDomainHostname(input.hostname);
    const teamIds = [...new Set(input.teamIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (teamIds.length === 0 || !teamIds.includes(input.defaultRegistrationTeamId)) throw new RelayError("domain_binding_default_team_invalid", "The default registration Team must be in the allowed Team set", 400);
    const permissions = await this.listResourcePermissionsForResource("user", input.ownerUserId);
    if (!permissions.some((permission) => permission.action === "user.domain_binding.manage" && permission.status === "enabled" && permission.subjectType === "user" && permission.subjectRef === input.ownerUserId)) {
      throw new RelayError("domain_binding_permission_required", "user.domain_binding.manage permission is required", 403);
    }
    for (const teamId of teamIds) {
      const team = await this.getTeam(teamId);
      if (!team || team.status !== "enabled" || team.ownerId !== input.ownerUserId) throw new RelayError("domain_binding_team_owner_required", "Every allowed Team must be enabled and owned by the binding owner", 403);
    }
    return this.withRetriedTransaction(async (transaction) => {
      const slot = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "domain_binding_slots" WHERE "owner_user_id" = $1 AND "status" = 'available' ORDER BY "created_at" ASC, "id" ASC LIMIT 1 FOR UPDATE`,
        [input.ownerUserId],
      );
      if (!slot) throw new RelayError("domain_binding_slot_unavailable", "No available domain binding slot exists", 409);
      const now = nowIso();
      const verificationValue = randomBytes(32).toString("base64url");
      const binding = await transaction.insertRow<DomainBinding>("domain_bindings", {
        id: createId("domain_binding"), hostname, ownerUserId: input.ownerUserId, slotId: slot.id,
        defaultRegistrationTeamId: input.defaultRegistrationTeamId, registrationInviteLinkId: null,
        status: "pending_verification", verificationMethod: "dns_txt", verificationTokenHash: postgresSha256Text(verificationValue),
        createdAt: now, updatedAt: now,
      }).catch((error: unknown) => {
        if (isPostgresUniqueViolation(error)) throw new RelayError("domain_binding_hostname_taken", "This hostname is already bound or reserved by the instance", 409);
        throw error;
      });
      for (const teamId of teamIds) {
        await transaction.query(
          `INSERT INTO "domain_binding_teams" ("domain_binding_id", "team_id", "created_at") VALUES ($1, $2, $3) ON CONFLICT ("domain_binding_id", "team_id") DO NOTHING`,
          [binding.id, teamId, now],
        );
      }
      await transaction.audit({ actor: { actorType: "user", actorId: input.ownerUserId }, action: "domain_binding.create", resource: { resourceType: "domain_binding", resourceId: binding.id }, result: "success", source: "web", metadata: { hostname, teamIds, defaultRegistrationTeamId: input.defaultRegistrationTeamId } });
      return { binding, verificationName: `_friday-relay-verify.${hostname}`, verificationValue };
    });
  }

  async consumeAbuseRateLimit(input: Parameters<ApplicationOperationPort["consumeAbuseRateLimit"]>[0]): Promise<AbuseRateLimitDecision> {
    validatePostgresAbuseRateLimitInput(input);
    const subjectHashes = [...new Set(input.subjectHashes)];
    const nowMs = input.nowMs ?? Date.now();
    assertAbuseTimestamp(nowMs);
    const windowMs = input.windowSeconds * 1_000;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const windowEnd = windowStart + windowMs;
    const now = new Date(nowMs).toISOString();
    return this.withRetriedTransaction(async (transaction) => {
      let retryAfterSeconds = 0;
      for (const subjectHash of subjectHashes) {
        const result = await transaction.query<{ count: number; blockedUntil: number | null }>(
          `INSERT INTO "abuse_rate_limit_counters"
            ("id", "bucket", "subject_hash", "window_start", "window_seconds", "count", "blocked_until", "created_at", "updated_at")
           VALUES ($1, $2, $3, $4, $5, 1, NULL, $6, $6)
           ON CONFLICT ("bucket", "subject_hash", "window_start", "window_seconds")
           DO UPDATE SET "count" = "abuse_rate_limit_counters"."count" + 1,
                         "updated_at" = EXCLUDED."updated_at"
           RETURNING "count", "blocked_until" AS "blockedUntil"`,
          [createId("abuse"), input.bucket, subjectHash, windowStart, input.windowSeconds, now],
        );
        const row = result.rows[0];
        if (!row) throw new Error("postgres_abuse_counter_readback_empty");
        const count = safePostgresInteger(row.count, "postgres_abuse_counter_count_invalid");
        const existingBlockedUntil = row.blockedUntil === null ? null : safePostgresInteger(row.blockedUntil, "postgres_abuse_counter_blocked_until_invalid");
        const blockedUntil = existingBlockedUntil !== null && existingBlockedUntil > nowMs
          ? existingBlockedUntil
          : count > input.limit
            ? windowEnd
            : null;
        if (blockedUntil !== existingBlockedUntil) {
          await transaction.query(
            `UPDATE "abuse_rate_limit_counters"
             SET "blocked_until" = $1, "updated_at" = $2
             WHERE "bucket" = $3 AND "subject_hash" = $4
               AND "window_start" = $5 AND "window_seconds" = $6`,
            [blockedUntil, now, input.bucket, subjectHash, windowStart, input.windowSeconds],
          );
        }
        if (blockedUntil !== null) retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((blockedUntil - nowMs) / 1_000)));
      }
      return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
    });
  }

  async consumeAbuseRateLimits(input: Parameters<ApplicationOperationPort["consumeAbuseRateLimits"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["consumeAbuseRateLimits"]>>> {
    const rules = validatePostgresAbuseRateLimitsInput(input);
    const nowMs = input.nowMs ?? Date.now();
    assertAbuseTimestamp(nowMs);
    const cleanupLimit = input.cleanupLimit ?? 100;
    if (!Number.isSafeInteger(cleanupLimit) || cleanupLimit < 0 || cleanupLimit > 1_000) throw new Error("Invalid abuse-rate cleanup limit");
    const now = new Date(nowMs).toISOString();
    return this.withRetriedTransaction(async (transaction) => {
      if (cleanupLimit > 0) {
        await transaction.query(
          `DELETE FROM "abuse_rate_limit_counters"
           WHERE "id" IN (
             SELECT "id" FROM "abuse_rate_limit_counters"
             WHERE ("window_start" + "window_seconds" * 1000) <= $1
               AND ("blocked_until" IS NULL OR "blocked_until" <= $1)
             ORDER BY "window_start" ASC, "id" ASC
             LIMIT $2
           )`,
          [nowMs, cleanupLimit],
        );
      }
      let retryAfterSeconds = 0;
      const deniedRuleIds: string[] = [];
      for (const rule of rules) {
        const windowMs = rule.windowSeconds * 1_000;
        const windowStart = Math.floor(nowMs / windowMs) * windowMs;
        const windowEnd = windowStart + windowMs;
        let ruleDenied = false;
        for (const subjectHash of rule.subjectHashes) {
          const result = await transaction.query<{ count: number; blockedUntil: number | null }>(
            `INSERT INTO "abuse_rate_limit_counters"
              ("id", "bucket", "subject_hash", "window_start", "window_seconds", "count", "blocked_until", "created_at", "updated_at")
             VALUES ($1, $2, $3, $4, $5, 1, NULL, $6, $6)
             ON CONFLICT ("bucket", "subject_hash", "window_start", "window_seconds")
             DO UPDATE SET "count" = "abuse_rate_limit_counters"."count" + 1,
                           "updated_at" = EXCLUDED."updated_at"
             RETURNING "count", "blocked_until" AS "blockedUntil"`,
            [createId("abuse"), rule.bucket, subjectHash, windowStart, rule.windowSeconds, now],
          );
          const row = result.rows[0];
          if (!row) throw new Error("postgres_abuse_counter_readback_empty");
          const count = safePostgresInteger(row.count, "postgres_abuse_counter_count_invalid");
          const existingBlockedUntil = row.blockedUntil === null ? null : safePostgresInteger(row.blockedUntil, "postgres_abuse_counter_blocked_until_invalid");
          const blockedUntil = existingBlockedUntil !== null && existingBlockedUntil > nowMs
            ? existingBlockedUntil
            : count > rule.limit
              ? windowEnd
              : null;
          if (blockedUntil !== existingBlockedUntil) {
            await transaction.query(
              `UPDATE "abuse_rate_limit_counters"
               SET "blocked_until" = $1, "updated_at" = $2
               WHERE "bucket" = $3 AND "subject_hash" = $4
                 AND "window_start" = $5 AND "window_seconds" = $6`,
              [blockedUntil, now, rule.bucket, subjectHash, windowStart, rule.windowSeconds],
            );
          }
          if (blockedUntil !== null) {
            ruleDenied = true;
            retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((blockedUntil - nowMs) / 1_000)));
          }
        }
        if (ruleDenied) deniedRuleIds.push(rule.id);
      }
      return { allowed: deniedRuleIds.length === 0, retryAfterSeconds, deniedRuleIds };
    });
  }

  async inspectAbuseRateLimit(input: Parameters<ApplicationOperationPort["inspectAbuseRateLimit"]>[0]): Promise<AbuseRateLimitDecision> {
    validatePostgresAbuseRateLimitInput(input);
    const subjectHashes = [...new Set(input.subjectHashes)];
    const nowMs = input.nowMs ?? Date.now();
    assertAbuseTimestamp(nowMs);
    const windowMs = input.windowSeconds * 1_000;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    let retryAfterSeconds = 0;
    for (const subjectHash of subjectHashes) {
      const row = await this.one<{ count: number; blockedUntil: number | null }>(
        `SELECT "count", "blocked_until" AS "blockedUntil"
         FROM "abuse_rate_limit_counters"
         WHERE "bucket" = $1 AND "subject_hash" = $2
           AND "window_start" = $3 AND "window_seconds" = $4`,
        [input.bucket, subjectHash, windowStart, input.windowSeconds],
      );
      if (!row) continue;
      const count = safePostgresInteger(row.count, "postgres_abuse_counter_count_invalid");
      const storedBlockedUntil = row.blockedUntil === null ? null : safePostgresInteger(row.blockedUntil, "postgres_abuse_counter_blocked_until_invalid");
      const blockedUntil = storedBlockedUntil !== null && storedBlockedUntil > nowMs
        ? storedBlockedUntil
        : count > input.limit
          ? windowStart + windowMs
          : null;
      if (blockedUntil !== null) retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((blockedUntil - nowMs) / 1_000)));
    }
    return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
  }

  async deleteExpiredAbuseRateLimits(nowMs = Date.now(), limit = 100): Promise<number> {
    assertAbuseTimestamp(nowMs);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid abuse-rate cleanup limit");
    const result = await this.query(
      `DELETE FROM "abuse_rate_limit_counters"
       WHERE "id" IN (
         SELECT "id" FROM "abuse_rate_limit_counters"
         WHERE ("window_start" + "window_seconds" * 1000) <= $1
           AND ("blocked_until" IS NULL OR "blocked_until" <= $1)
         ORDER BY "window_start" ASC, "id" ASC
         LIMIT $2
       )`,
      [nowMs, limit],
    );
    return result.rowCount ?? 0;
  }

  async listEffectiveSubscriptionScopesForUser(userId: string): Promise<ScopeRef[]> {
    const memberships = await this.listAvailableTeamMemberships(userId);
    return ["global:", ...memberships.map((membership) => `team:${membership.teamId}` as const), `user:${userId}` as const];
  }

  async getActivePlanIdentity(
    scopeRefs: ScopeRef[],
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getActivePlanIdentity"]>>> {
    const uniqueScopes = [...new Set(scopeRefs)].slice(0, 50);
    if (uniqueScopes.length === 0) return undefined;
    const placeholders = uniqueScopes.map((_, index) => `$${index + 1}`).join(", ");
    const atParameter = uniqueScopes.length + 1;
    const orderCases = uniqueScopes.map((_, index) => `WHEN $${index + 1} THEN ${index}`).join(" ");
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getActivePlanIdentity"]>>>(
      `SELECT subscription."id" AS "subscriptionId", subscription."plan_id" AS "planId",
              subscription."scope_ref" AS "scopeRef", subscription."source", subscription."priority",
              subscription."effective_start" AS "effectiveStart", subscription."effective_end" AS "effectiveEnd",
              subscription."subscription_lifecycle" AS "subscriptionLifecycle",
              plan."name" AS "planName", plan."version" AS "planVersion", plan."billing_mode" AS "billingMode",
              plan."purchase_amount" AS "purchaseAmount", plan."duration_seconds" AS "durationSeconds",
              plan."plan_status" AS "planStatus"
       FROM "plan_subscriptions" subscription
       INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."scope_ref" IN (${placeholders})
         AND subscription."subscription_lifecycle" = 'active'
         AND subscription."effective_start" <= $${atParameter}
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $${atParameter})
         AND plan."plan_status" IN ('enabled', 'closed')
       ORDER BY CASE subscription."scope_ref" ${orderCases} ELSE 999 END ASC,
                subscription."priority" ASC, subscription."effective_start" ASC,
                subscription."created_at" ASC, subscription."id" ASC
       LIMIT 1`,
      [...uniqueScopes, at],
    );
  }

  async pageBudgetLimits(
    planId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageBudgetLimits"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "plan_budget_limits" WHERE "plan_id" = $1`,
      [planId],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_budget_limit_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageBudgetLimits"]>>["items"][number]>(
      `SELECT * FROM "plan_budget_limits"
       WHERE "plan_id" = $1
       ORDER BY CASE "limit_scope" WHEN 'subscription' THEN 0 ELSE 1 END ASC,
                "metric" ASC, "window_type" ASC, COALESCE("window_seconds", -1) ASC,
                "limit_value" ASC, "created_at" ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [planId, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pagePlanAccessPoints(
    planId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePlanAccessPoints"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "plan_access_points" WHERE "plan_id" = $1`,
      [planId],
    ))?.count ?? 0, "postgres_plan_access_point_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    type RelationRow = Omit<Awaited<ReturnType<ApplicationOperationPort["pagePlanAccessPoints"]>>["items"][number], "basePrice" | "effectivePrice">;
    const rows = await this.rows<RelationRow>(
      `SELECT relation."id" AS "relationId", relation."plan_id" AS "planId",
              access_point."id" AS "accessPointId", access_point."owner_id" AS "ownerId",
              access_point."name", access_point."scope_ref" AS "scopeRef",
              access_point."api_family" AS "apiFamily", access_point."exposed_model" AS "exposedModel",
              access_point."status", relation."created_at" AS "createdAt"
       FROM "plan_access_points" relation
       INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
       WHERE relation."plan_id" = $1
       ORDER BY lower(access_point."name") ASC, access_point."id" ASC, relation."id" ASC
       LIMIT $2 OFFSET $3`,
      [planId, pageSize, (normalizedPage - 1) * pageSize],
    );
    const items = await Promise.all(rows.map(async (row) => {
      const effective = await this.findEffectivePlanAccessPointPrice(row.planId, row.accessPointId);
      if (!effective) return { ...row, basePrice: null, effectivePrice: null };
      const basePrice = effective.basePrice ? { ...effective.basePrice, tiers: effective.basePrice.tiers ?? [] } : null;
      if (effective.source === "plan_access_point" && effective.planAccessPointPrice) {
        const planAccessPointPrice = { ...effective.planAccessPointPrice, tiers: effective.planAccessPointPrice.tiers ?? [] };
        return {
          ...row,
          basePrice,
          effectivePrice: { source: "plan_access_point" as const, price: planAccessPointPrice, basePrice, planAccessPointPrice },
        };
      }
      if (effective.source === "access_point" && effective.basePrice) {
        const accessPointPrice = { ...effective.basePrice, tiers: effective.basePrice.tiers ?? [] };
        return {
          ...row,
          basePrice,
          effectivePrice: { source: "access_point" as const, price: accessPointPrice, basePrice: accessPointPrice, planAccessPointPrice: null },
        };
      }
      return { ...row, basePrice, effectivePrice: null };
    }));
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async getPlanStatusImpact(
    planId: string,
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getPlanStatusImpact"]>>> {
    const row = await this.one<{ availableCardCount: number; activeOrFutureSubscriptionCount: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM "cards" card
          WHERE card."plan_id" = $1 AND card."used_at" IS NULL AND card."invalidated_at" IS NULL
            AND card."expires_at" > $2
            AND NOT EXISTS (SELECT 1 FROM "cards" replacement WHERE replacement."replaces_card_id" = card."id")
          ) + (SELECT COUNT(*)::int FROM "card_activation_codes" code
               INNER JOIN "card_activation_batches" batch ON batch."id" = code."batch_id"
               WHERE batch."plan_id" = $1 AND code."redeemed_at" IS NULL AND code."revoked_at" IS NULL
                 AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" > $2) AS "availableCardCount",
         (SELECT COUNT(*)::int FROM "plan_subscriptions" subscription
          WHERE subscription."plan_id" = $1 AND subscription."subscription_lifecycle" = 'active'
            AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)) AS "activeOrFutureSubscriptionCount"`,
      [planId, at],
    );
    return {
      availableCardCount: safePostgresInteger(row?.availableCardCount ?? 0, "postgres_plan_available_card_count_invalid"),
      activeOrFutureSubscriptionCount: safePostgresInteger(row?.activeOrFutureSubscriptionCount ?? 0, "postgres_plan_subscription_impact_count_invalid"),
    };
  }

  async pagePlanDirectory(
    input: Parameters<ApplicationOperationPort["pagePlanDirectory"]>[0] = {},
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePlanDirectory"]>>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const queryValue = query ? `%${query}%` : "";
    const values: unknown[] = [];
    const conditions: string[] = [];
    const countValues: unknown[] = [];
    const countConditions: string[] = [];
    if (query) {
      const queryParameter = values.push(queryValue);
      conditions.push(`(lower(plan."name") LIKE $${queryParameter} OR lower(plan."id") LIKE $${queryParameter} OR lower(plan."scope_ref") LIKE $${queryParameter})`);
      const countQueryParameter = countValues.push(queryValue);
      countConditions.push(`(lower(plan."name") LIKE $${countQueryParameter} OR lower(plan."id") LIKE $${countQueryParameter} OR lower(plan."scope_ref") LIKE $${countQueryParameter})`);
    }
    const atParameter = values.push(at);
    if (input.status && input.status !== "all") {
      const statusParameter = values.push(input.status);
      conditions.push(`plan."plan_status" = $${statusParameter}`);
      const countStatusParameter = countValues.push(input.status);
      countConditions.push(`plan."plan_status" = $${countStatusParameter}`);
    }
    const filter = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countFilter = countConditions.length > 0 ? `WHERE ${countConditions.join(" AND ")}` : "";
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "plans" plan ${countFilter}`, countValues))?.count ?? 0, "postgres_plan_directory_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const limitParam = values.length + 1;
    const offsetParam = values.length + 2;
    const rows = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pagePlanDirectory"]>>["items"][number] & { accessPointNames: string | null }>(
      `SELECT plan."id", plan."owner_id" AS "ownerId", plan."scope_ref" AS "scopeRef", plan."name",
              plan."version", plan."description", plan."admin_note" AS "adminNote",
              plan."billing_mode" AS "billingMode", plan."purchase_amount" AS "purchaseAmount",
              plan."duration_seconds" AS "durationSeconds", plan."plan_status" AS "planStatus",
              plan."catalog_status" AS "catalogStatus", plan."created_at" AS "createdAt", plan."updated_at" AS "updatedAt",
              (SELECT COUNT(*)::int FROM "plan_budget_limits" budget WHERE budget."plan_id" = plan."id") AS "budgetLimitCount",
              (SELECT COUNT(*)::int FROM "plan_access_points" relation WHERE relation."plan_id" = plan."id") AS "accessPointCount",
              (SELECT string_agg(preview."name", chr(31) ORDER BY lower(preview."name"), preview."id")
               FROM (SELECT access_point."name", access_point."id"
                     FROM "plan_access_points" relation INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
                     WHERE relation."plan_id" = plan."id"
                     ORDER BY lower(access_point."name") ASC, access_point."id" ASC LIMIT 3) preview) AS "accessPointNames",
              (SELECT COUNT(*)::int FROM "cards" card
               WHERE card."plan_id" = plan."id" AND card."used_at" IS NULL AND card."invalidated_at" IS NULL
                 AND card."expires_at" > $${atParameter} AND NOT EXISTS (SELECT 1 FROM "cards" replacement WHERE replacement."replaces_card_id" = card."id")) AS "availableCardCount",
              (SELECT COUNT(*)::int FROM "plan_subscriptions" subscription
               WHERE subscription."plan_id" = plan."id" AND subscription."subscription_lifecycle" = 'active'
                 AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $${atParameter})) AS "activeOrFutureSubscriptionCount"
       FROM "plans" plan ${filter}
       ORDER BY lower(plan."name") ASC, plan."version" DESC, plan."id" ASC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(({ accessPointNames, ...row }) => ({ ...row, accessPointNames: accessPointNames?.split(String.fromCharCode(31)) ?? [] })), page, pageSize, total, totalPages };
  }

  async pagePlanSubscriptions(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePlanSubscriptions"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "plan_subscriptions"`, []))?.count ?? 0, "postgres_plan_subscription_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pagePlanSubscriptions"]>>["items"][number]>(
      `SELECT "id", "plan_id" AS "planId", "source", "scope_ref" AS "scopeRef",
              "purchased_by_user_id" AS "purchasedByUserId", "funding_account_id" AS "fundingAccountId",
              "origin_card_id" AS "originCardId", "priority", "effective_start" AS "effectiveStart",
              "effective_end" AS "effectiveEnd", "subscription_lifecycle" AS "subscriptionLifecycle",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "plan_subscriptions" ORDER BY "effective_start" ASC, "id" ASC LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async countPlanSubscriptions(filter: Parameters<ApplicationOperationPort["countPlanSubscriptions"]>[0] = {}): Promise<number> {
    const { sql, values } = postgresPlanSubscriptionFilter(filter);
    return safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "plan_subscriptions" ${sql}`, values))?.count ?? 0, "postgres_plan_subscription_count_invalid");
  }

  async listPlanSubscriptionSources(): Promise<string[]> {
    const rows = await this.rows<{ source: string }>(
      `SELECT DISTINCT "source" FROM "plan_subscriptions" ORDER BY "source" ASC`,
      [],
    );
    return rows.map((row) => row.source);
  }

  async getPlanSubscription(id: string): Promise<PlanSubscription | undefined> {
    return this.one<PlanSubscription>(`SELECT * FROM "plan_subscriptions" WHERE "id" = $1`, [id]);
  }

  async listPlanSubscriptions(filter: Parameters<ApplicationOperationPort["listPlanSubscriptions"]>[0] = {}, limit = 50, offset = 0): Promise<PlanSubscription[]> {
    const { sql, values } = postgresPlanSubscriptionFilter(filter ?? {});
    return this.rows<PlanSubscription>(
      `SELECT * FROM "plan_subscriptions" ${sql} ORDER BY "scope_ref" ASC, "priority" ASC, "effective_start" ASC, "created_at" ASC, "id" ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset))],
    );
  }

  async isPlanSubscriptionUserEligible(subscriptionId: string, userId: string, at = nowIso()): Promise<boolean> {
    const subscription = await this.getPlanSubscription(subscriptionId);
    if (!subscription) return false;
    if (subscription.scopeRef === "global:") return Boolean(await this.one(`SELECT 1 FROM "user_controls" WHERE "id" = $1 AND "status" = 'enabled'`, [userId]));
    if (subscription.scopeRef.startsWith("user:")) return subscription.scopeRef === `user:${userId}` && Boolean(await this.one(`SELECT 1 FROM "user_controls" WHERE "id" = $1 AND "status" = 'enabled'`, [userId]));
    if (!subscription.scopeRef.startsWith("team:")) return false;
    const teamId = subscription.scopeRef.slice("team:".length);
    const current = await this.one(`SELECT 1 FROM "team_memberships" membership INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled' INNER JOIN "user_controls" user_row ON user_row."id" = membership."user_id" AND user_row."status" = 'enabled' WHERE membership."team_id" = $1 AND membership."user_id" = $2`, [teamId, userId]);
    if (current) return true;
    if (subscription.effectiveEnd && Date.parse(subscription.effectiveEnd) <= Date.parse(at)) {
      return Boolean(await this.one(`SELECT 1 FROM (${POSTGRES_REQUEST_IDENTITY_SOURCE}) log INNER JOIN "billing_history_refs" event ON event."request_id" = log."request_id" WHERE log."user_id" = $1 AND event."billing_subscription_id" = $2 LIMIT 1`, [userId, subscription.id]));
    }
    return false;
  }

  async pageTeamProviderDirectory(
    scopeRef: ScopeRef,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageTeamProviderDirectory"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "providers" WHERE "scope_ref" = $1`,
      [scopeRef],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_team_provider_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageTeamProviderDirectory"]>>["items"][number]>(
      `SELECT provider."id", provider."name", provider."kind", provider."status",
              binding."auth_method" AS "authMethod", binding."credential_preview" AS "credentialPreview",
              binding."sync_status" AS "bindingStatus", binding."revision" AS "bindingRevision",
              binding."updated_at" AS "bindingUpdatedAt",
              (SELECT COUNT(*)::int FROM "provider_models" model WHERE model."provider_id" = provider."id") AS "modelCount",
              ARRAY(
                SELECT model."provider_model_name"
                FROM "provider_models" model
                WHERE model."provider_id" = provider."id" AND model."status" = 'enabled'
                ORDER BY model."provider_model_name" ASC, model."id" ASC
                LIMIT 3
              ) AS "modelNames",
              provider."created_at" AS "createdAt", provider."updated_at" AS "updatedAt"
       FROM "providers" provider
       LEFT JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
       WHERE provider."scope_ref" = $1
       ORDER BY provider."created_at" ASC, provider."id" ASC
       LIMIT $2 OFFSET $3`,
      [scopeRef, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageUserStore(
    userId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserStore"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const filter = `
      WHERE plan."plan_status" = 'enabled'
        AND plan."catalog_status" = 'listed'
        AND plan."billing_mode" = 'prepaid'
        AND plan."duration_seconds" > 0
        AND ROUND(plan."purchase_amount" * 1000000) > 0
        AND (
          plan."scope_ref" = 'global:'
          OR plan."scope_ref" = 'user:' || $1
          OR EXISTS (
            SELECT 1
            FROM "team_memberships" membership
            INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
            WHERE membership."user_id" = $1
              AND plan."scope_ref" = 'team:' || membership."team_id"
          )
        )`;
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "plans" plan ${filter}`,
      [userId],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_user_plan_store_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    type PlanStoreRow = Awaited<ReturnType<ApplicationOperationPort["pageUserStore"]>>["items"][number];
    const rows = await this.rows<Omit<PlanStoreRow, "paymentListings">>(
      `SELECT plan."id", plan."name", plan."version", plan."description",
              plan."purchase_amount" AS "purchaseAmount", plan."duration_seconds" AS "durationSeconds",
              (SELECT COUNT(*)::int FROM "plan_access_points" relation WHERE relation."plan_id" = plan."id") AS "accessPointCount"
       FROM "plans" plan
       ${filter}
       ORDER BY lower(plan."name") ASC, plan."version" DESC, plan."id" ASC
       LIMIT $2 OFFSET $3`,
      [userId, pageSize, (normalizedPage - 1) * pageSize],
    );
    const listingsByPlanId = new Map<string, PlanStoreRow["paymentListings"]>();
    if (rows.length > 0) {
      const planIds = rows.map((row) => row.id);
      const placeholders = planIds.map((_, index) => `$${index + 1}`).join(", ");
      const listings = await this.rows<PlanStoreRow["paymentListings"][number]>(
        `SELECT listing."id", listing."plan_id" AS "planId",
                listing."payment_channel_id" AS "paymentChannelId",
                channel."display_name" AS "channelDisplayName",
                channel."payment_network" AS "paymentNetwork",
                channel."payment_asset" AS "paymentAsset",
                channel."settlement_mode" AS "settlementMode",
                listing."price_amount_units" AS "priceAmountUnits"
         FROM "plan_payment_listings" listing
         INNER JOIN "payment_channels" channel ON channel."id" = listing."payment_channel_id"
         WHERE listing."plan_id" IN (${placeholders})
           AND listing."status" = 'enabled'
           AND channel."status" = 'enabled'
           AND channel."payment_network" = 'stripe'
           AND channel."settlement_mode" = 'stripe_checkout'
         ORDER BY listing."plan_id" ASC, channel."payment_asset" ASC,
                  listing."created_at" ASC, listing."id" ASC`,
        planIds,
      );
      for (const listing of listings) {
        const group = listingsByPlanId.get(listing.planId) ?? [];
        group.push(listing);
        listingsByPlanId.set(listing.planId, group);
      }
    }
    const items = rows.map((row) => ({ ...row, paymentListings: listingsByPlanId.get(row.id) ?? [] }));
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pagePurchasableAuthorityProducts(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePurchasableAuthorityProducts"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "authority_products" WHERE "lifecycle" = 'listed'`,
      [],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_authority_product_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pagePurchasableAuthorityProducts"]>>["items"][number]>(
      `SELECT * FROM "authority_products"
       WHERE "lifecycle" = 'listed'
       ORDER BY "code" ASC, "version" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageAuthorityProducts(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageAuthorityProducts"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "authority_products"`,
      [],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_authority_product_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageAuthorityProducts"]>>["items"][number]>(
      `SELECT * FROM "authority_products"
       ORDER BY "code" ASC, "version" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async getAuthorityProduct(id: string): Promise<AuthorityProduct | undefined> {
    return this.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1`, [id]);
  }

  async getAuthorityGrant(id: string): Promise<AuthorityGrant | undefined> {
    return this.one<AuthorityGrant>(`SELECT * FROM "authority_grants" WHERE "id" = $1`, [id]);
  }

  async createAuthorityProductVersion(input: AuthorityProductTermsForPostgres): Promise<AuthorityProduct> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(input.actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const terms = await transaction.validatePostgresAuthorityProductTerms(input);
      const code = postgresRequiredCode(input.code, "code");
      const version = Number((await transaction.one<{ version: number }>(`SELECT COALESCE(MAX("version"), 0)::int + 1 AS "version" FROM "authority_products" WHERE "code" = $1`, [code]))?.version ?? 1);
      const now = nowIso();
      const row = await transaction.insertRow<AuthorityProduct>("authority_products", {
        id: createId("authority_product"), code, version, ...terms, lifecycle: "draft",
        createdByOwnerUserId: actor.id, createdAt: now, updatedAt: now,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "authority_product.create", resource: { resourceType: "authority_product", resourceId: row.id }, result: "success", source: "owner", metadata: { code, version, effectCode: row.effectCode, lifecycle: row.lifecycle } });
      return row;
    });
  }

  async updateDraftAuthorityProduct(id: string, input: AuthorityDraftProductInputForPostgres): Promise<AuthorityProduct> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(input.actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const product = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle !== "draft") throw new RelayError("authority_product_frozen", "Only draft Authority Products can be edited", 409);
      const terms = await transaction.validatePostgresAuthorityProductTerms(input);
      const updated = await transaction.query<AuthorityProduct>(
        `UPDATE "authority_products" SET "display_name" = $2, "effect_code" = $3, "grant_units" = $4,
         "purchase_amount_units" = $5, "grant_duration_seconds" = $6, "max_lifetime_purchases_per_user" = $7,
         "max_unconsumed_units_per_user" = $8, "max_current_owned_teams" = $9, "max_lifetime_created_teams" = $10,
         "refund_mode" = $11, "refund_deadline_seconds" = $12, "settlement_hold_seconds" = $13,
         "seller_scope_ref" = $14, "updated_at" = $15 WHERE "id" = $1 RETURNING *`,
        [id, terms.displayName, terms.effectCode, terms.grantUnits, terms.purchaseAmountUnits, terms.grantDurationSeconds, terms.maxLifetimePurchasesPerUser, terms.maxUnconsumedUnitsPerUser, terms.maxCurrentOwnedTeams, terms.maxLifetimeCreatedTeams, terms.refundMode, terms.refundDeadlineSeconds, terms.settlementHoldSeconds, terms.sellerScopeRef, nowIso()],
      );
      if (!updated.rows[0]) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "authority_product.update", resource: { resourceType: "authority_product", resourceId: id }, result: "success", source: "owner", metadata: { code: product.code, version: product.version, lifecycle: product.lifecycle } });
      return mapPostgresRow<AuthorityProduct>(updated.rows[0]);
    });
  }

  async listAuthorityProductVersion(id: string, actorOwnerUserId: string): Promise<AuthorityProduct> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const product = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle !== "draft") throw new RelayError("authority_product_not_draft", "Only draft Authority Products can be listed", 409);
      const previous = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "code" = $1 AND "lifecycle" = 'listed' AND "id" <> $2 FOR UPDATE`, [product.code, id]);
      const now = nowIso();
      if (previous) await transaction.query(`UPDATE "authority_products" SET "lifecycle" = 'closed', "updated_at" = $2 WHERE "id" = $1`, [previous.id, now]);
      const updated = await transaction.query<AuthorityProduct>(`UPDATE "authority_products" SET "lifecycle" = 'listed', "updated_at" = $2 WHERE "id" = $1 RETURNING *`, [id, now]);
      if (!updated.rows[0]) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "authority_product.list", resource: { resourceType: "authority_product", resourceId: id }, result: "success", source: "owner", metadata: { code: product.code, version: product.version, replacedProductId: previous?.id ?? null } });
      return mapPostgresRow<AuthorityProduct>(updated.rows[0]);
    });
  }

  async closeAuthorityProduct(id: string, actorOwnerUserId: string): Promise<AuthorityProduct> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const product = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle === "closed") return product;
      if (product.lifecycle !== "listed") throw new RelayError("authority_product_not_listed", "Only listed Authority Products can be closed", 409);
      const updated = await transaction.query<AuthorityProduct>(`UPDATE "authority_products" SET "lifecycle" = 'closed', "updated_at" = $2 WHERE "id" = $1 RETURNING *`, [id, nowIso()]);
      if (!updated.rows[0]) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "authority_product.close", resource: { resourceType: "authority_product", resourceId: id }, result: "success", source: "owner", metadata: { code: product.code, version: product.version } });
      return mapPostgresRow<AuthorityProduct>(updated.rows[0]);
    });
  }

  async grantTeamProviderAccess(input: { teamId: string; productId: string; actorOwnerUserId: string; idempotencyKey: string }): Promise<{ entitlement: TeamProviderEntitlement; replayed: boolean }> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(input.actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ teamId: input.teamId, productId: input.productId }));
      const existing = await transaction.one<TeamProviderEntitlement>(`SELECT * FROM "team_provider_entitlements" WHERE "issued_by_user_id" = $1 AND "idempotency_key_hash" = $2`, [actor.id, idempotencyKeyHash]);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Team Provider grant", 409);
        return { entitlement: existing, replayed: true };
      }
      const team = await transaction.getTeam(input.teamId);
      if (!team || team.status !== "enabled") throw new RelayError("team_not_found", "Enabled Team not found", 404);
      const product = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1 FOR UPDATE`, [input.productId]);
      if (!product) throw new RelayError("authority_product_not_found", "Authority Product not found", 404);
      if (product.lifecycle !== "listed" || product.effectCode !== "team_custom_provider_access") throw new RelayError("authority_product_not_grantable", "Authority Product is not grantable for Team Provider access", 409);
      const permanent = await transaction.one<{ id: string }>(`SELECT "id" FROM "team_provider_entitlements" WHERE "team_id" = $1 AND "lifecycle" = 'active' AND "effective_end" IS NULL LIMIT 1`, [team.id]);
      if (permanent) throw new RelayError("team_provider_entitlement_permanent", "Team already has permanent Provider access", 409);
      const now = nowIso();
      const previous = await transaction.one<{ effectiveEnd: string }>(`SELECT MAX("effective_end") AS "effectiveEnd" FROM "team_provider_entitlements" WHERE "team_id" = $1 AND "lifecycle" = 'active' AND "effective_end" IS NOT NULL AND "effective_end" > $2`, [team.id, now]);
      const effectiveStart = previous?.effectiveEnd ?? now;
      const entitlement = await transaction.insertRow<TeamProviderEntitlement>("team_provider_entitlements", {
        id: createId("team_provider_entitlement"), teamId: team.id, sourceKind: "admin_grant", sourceAuthorityPurchaseId: null, sourceAuthorityProductId: product.id,
        sourceProductCodeSnapshot: product.code, sourceProductVersionSnapshot: product.version, sourceProductDisplayNameSnapshot: product.displayName,
        buyerUserId: null, issuedByUserId: actor.id, effectiveStart, effectiveEnd: postgresAddSeconds(effectiveStart, product.grantDurationSeconds), lifecycle: "active",
        canceledAt: null, canceledByUserId: null, cancelReasonCode: null, idempotencyKeyHash, requestHash, createdAt: now,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "team_provider_entitlement.grant", resource: { resourceType: "team_provider_entitlement", resourceId: entitlement.id }, result: "success", source: "owner", metadata: { teamId: team.id, productId: product.id, productCode: product.code, productVersion: product.version, effectiveStart: entitlement.effectiveStart, effectiveEnd: entitlement.effectiveEnd } });
      return { entitlement, replayed: false };
    });
  }

  async cancelTeamProviderEntitlement(input: { entitlementId: string; actorOwnerUserId: string; reasonCode: string }): Promise<TeamProviderEntitlement> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(input.actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      postgresValidateAuthorityCancelReason(input.reasonCode, "team_provider_entitlement_cancel_reason_invalid");
      const entitlement = await transaction.one<TeamProviderEntitlement>(`SELECT * FROM "team_provider_entitlements" WHERE "id" = $1 FOR UPDATE`, [input.entitlementId]);
      if (!entitlement) throw new RelayError("team_provider_entitlement_not_found", "Team Provider entitlement not found", 404);
      if (entitlement.sourceKind === "legacy_migration") throw new RelayError("team_provider_entitlement_permanent", "Permanent Team Provider entitlement cannot be canceled", 409);
      if (entitlement.lifecycle === "canceled") {
        if (entitlement.cancelReasonCode !== input.reasonCode) throw new RelayError("team_provider_entitlement_cancel_conflict", "Team Provider entitlement was already canceled with another reason", 409);
        return entitlement;
      }
      const canceledAt = nowIso();
      const updated = await transaction.query<TeamProviderEntitlement>(`UPDATE "team_provider_entitlements" SET "lifecycle" = 'canceled', "canceled_at" = $2, "canceled_by_user_id" = $3, "cancel_reason_code" = $4 WHERE "id" = $1 RETURNING *`, [entitlement.id, canceledAt, actor.id, input.reasonCode]);
      if (!updated.rows[0]) throw new RelayError("team_provider_entitlement_not_found", "Team Provider entitlement not found", 404);
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "team_provider_entitlement.cancel", resource: { resourceType: "team_provider_entitlement", resourceId: entitlement.id }, result: "success", source: "owner", metadata: { teamId: entitlement.teamId, reasonCode: input.reasonCode, sourceKind: entitlement.sourceKind } });
      return mapPostgresRow<TeamProviderEntitlement>(updated.rows[0]);
    });
  }

  async cancelAuthorityGrant(input: { grantId: string; actorOwnerUserId: string; reasonCode: string }): Promise<AuthorityGrant> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(input.actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      postgresValidateAuthorityCancelReason(input.reasonCode, "authority_cancel_reason_invalid");
      const grant = await transaction.one<AuthorityGrant>(`SELECT * FROM "authority_grants" WHERE "id" = $1 FOR UPDATE`, [input.grantId]);
      if (!grant) throw new RelayError("authority_grant_not_found", "Authority Grant not found", 404);
      if (grant.sourceKind === "system_bootstrap") throw new RelayError("authority_owner_cancel_blocked", "Bootstrap Owner Grant requires offline handover", 409);
      if (grant.lifecycle === "canceled") {
        if (grant.cancelReasonCode !== input.reasonCode) throw new RelayError("authority_cancel_conflict", "Authority Grant was already canceled with another reason", 409);
        return grant;
      }
      const updated = await transaction.query<AuthorityGrant>(`UPDATE "authority_grants" SET "lifecycle" = 'canceled', "canceled_at" = $2, "canceled_by_user_id" = $3, "cancel_reason_code" = $4 WHERE "id" = $1 RETURNING *`, [grant.id, nowIso(), actor.id, input.reasonCode]);
      if (!updated.rows[0]) throw new RelayError("authority_grant_not_found", "Authority Grant not found", 404);
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "authority_grant.cancel", resource: { resourceType: "authority_grant", resourceId: grant.id }, result: "success", source: "owner", metadata: { reasonCode: input.reasonCode, sourceKind: grant.sourceKind } });
      return mapPostgresRow<AuthorityGrant>(updated.rows[0]);
    });
  }

  async refundAuthorityPurchase(input: { purchaseId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string }): Promise<AuthorityRefundResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const actor = await transaction.getUser(input.actorOwnerUserId);
      if (!actor || actor.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      postgresValidateAuthorityRefundReason(input.reasonCode);
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ purchaseId: input.purchaseId, reasonCode: input.reasonCode }));
      const idempotent = await transaction.one<AuthorityRefund>(`SELECT * FROM "authority_refunds" WHERE "actor_owner_user_id" = $1 AND "idempotency_key_hash" = $2`, [actor.id, idempotencyKeyHash]);
      if (idempotent) {
        if (idempotent.requestHash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority refund", 409);
        return transaction.postgresAuthorityRefundResult(idempotent);
      }
      await transaction.query(
        `SELECT "window_key" FROM "seller_settlement_windows" WHERE "authority_purchase_id" = $1 ORDER BY "window_key" FOR UPDATE`,
        [input.purchaseId],
      );
      const purchase = await transaction.one<AuthorityPurchase>(`SELECT * FROM "authority_purchases" WHERE "id" = $1 FOR UPDATE`, [input.purchaseId]);
      if (!purchase) throw new RelayError("authority_purchase_not_found", "Authority Purchase not found", 404);
      const existingRefund = await transaction.one<AuthorityRefund>(`SELECT * FROM "authority_refunds" WHERE "authority_purchase_id" = $1`, [purchase.id]);
      if (existingRefund) return transaction.postgresAuthorityRefundResult(existingRefund);
      if (purchase.refundMode !== "unused_by_owner" || purchase.refundDeadlineSeconds === null) throw new RelayError("authority_refund_not_allowed", "Authority Purchase is not refundable", 409);
      const now = nowIso();
      if (now >= postgresAddSeconds(purchase.createdAt, purchase.refundDeadlineSeconds)) throw new RelayError("authority_refund_deadline_exceeded", "Authority Purchase refund deadline has elapsed", 409);
      const grant = await transaction.one<AuthorityGrant>(`SELECT * FROM "authority_grants" WHERE "source_purchase_id" = $1 FOR UPDATE`, [purchase.id]);
      if (!grant || grant.sourceKind !== "product_purchase") throw new RelayError("authority_purchase_corrupt", "Authority Purchase Grant is missing", 500);
      if (grant.lifecycle !== "active") throw new RelayError("authority_grant_not_refundable", "Canceled Authority Grant cannot be refunded", 409);
      const used = await transaction.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "authority_uses" use_row INNER JOIN "authority_grant_quotas" quota ON quota."id" = use_row."grant_quota_id" WHERE quota."grant_id" = $1`, [grant.id]);
      if (Number(used?.count ?? 0) > 0) throw new RelayError("authority_grant_already_used", "Consumed Authority Grant cannot be refunded", 409);
      const settlement = await transaction.rows<{ id: string; eventType: string; releaseAt: string }>(`SELECT "id", "event_type" AS "eventType", "release_at" AS "releaseAt" FROM "seller_settlement_events" WHERE "authority_purchase_id" = $1 ORDER BY "created_at", "id"`, [purchase.id]);
      const revenue = settlement.find((row) => row.eventType === "revenue");
      if (!revenue) throw new RelayError("authority_purchase_corrupt", "Authority Purchase Seller revenue is missing", 500);
      if (settlement.some((row) => row.eventType === "release")) throw new RelayError("authority_refund_already_settled", "Released Authority Purchase cannot be refunded", 409);
      if (settlement.some((row) => row.eventType === "reversal")) throw new RelayError("authority_purchase_corrupt", "Authority Purchase settlement was reversed without a refund fact", 500);
      const purchaseLedger = await transaction.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "authority_purchase_id" = $1 AND "event_type" = 'authority_purchase'`, [purchase.id]);
      if (!purchaseLedger) throw new RelayError("authority_purchase_corrupt", "Authority Purchase credit ledger event is missing", 500);
      const refund = await transaction.insertRow<AuthorityRefund>("authority_refunds", { id: createId("authority_refund"), authorityPurchaseId: purchase.id, authorityGrantId: grant.id, actorOwnerUserId: actor.id, reasonCode: input.reasonCode, idempotencyKeyHash, requestHash, createdAt: now });
      await transaction.query(`UPDATE "authority_grants" SET "lifecycle" = 'canceled', "canceled_at" = $2, "canceled_by_user_id" = $3, "cancel_reason_code" = 'refund' WHERE "id" = $1`, [grant.id, now, actor.id]);
      const reversalLedger = await transaction.createCreditLedgerEvent({ accountId: purchase.creditAccountId, eventType: "reversal", amountUnits: purchase.purchaseAmountUnits, transferId: null, relatedEventId: purchaseLedger.id, planSubscriptionId: null, authorityPurchaseId: purchase.id, billingEventId: null, fromAccountId: null, toAccountId: purchase.creditAccountId, reason: `authority_refund:${input.reasonCode}`, actorUserId: actor.id, createdAt: now });
      const settlementReversal = await transaction.insertRow("seller_settlement_events", { id: createId("seller_settlement"), planSubscriptionId: null, authorityPurchaseId: purchase.id, sellerScopeRef: purchase.sellerScopeRef, windowStart: purchase.createdAt, windowEnd: revenue.releaseAt, releaseAt: revenue.releaseAt, eventType: "reversal", amountUnits: purchase.purchaseAmountUnits, sourceType: "authority_refund", sourceId: refund.id, createdAt: now });
      await transaction.audit({ actor: { actorType: "user", actorId: actor.id }, action: "authority_purchase.refund", resource: { resourceType: "authority_purchase", resourceId: purchase.id }, result: "success", source: "owner", metadata: { refundId: refund.id, grantId: grant.id, reasonCode: refund.reasonCode, purchaseAmountUnits: purchase.purchaseAmountUnits } });
      return { refund, creditLedgerEventId: reversalLedger.id, sellerSettlementReversalId: String((settlementReversal as { id: string }).id) };
    });
  }

  async searchTeamProviderProductCandidates(
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchTeamProviderProductCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "authority_products" WHERE "lifecycle" = 'listed' AND "effect_code" = 'team_custom_provider_access'`,
      `SELECT "id", "code", "version", "display_name" AS "displayName", "grant_duration_seconds" AS "grantDurationSeconds"`,
      ["code", "display_name"],
      query,
      page,
      `ORDER BY lower("display_name"), "code", "version" DESC, "id"`,
    );
  }

  async searchWebRegistrationCandidates(query = "", cursor: string | null = null): Promise<{ items: Array<{ id: string; name: string }>; nextCursor: string | null }> {
    const trimmed = query.trim();
    if (trimmed.length > 100) throw new RelayError("invalid_web_registration_team_query", "Team search query is too long", 400);
    const normalized = trimmed.toLowerCase();
    const after = cursor ? decodePostgresWebRegistrationCursor(cursor) : null;
    const rows = await this.rows<{ id: string; name: string }>(
      `SELECT "id", "name"
       FROM "teams" team
       WHERE team."status" = 'enabled'
         AND NOT EXISTS (
           SELECT 1 FROM "team_deletion_lifecycles" deletion
           WHERE deletion."team_id" = team."id"
             AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
         )
         AND ($1 = '' OR position($1 IN lower(team."id")) > 0 OR position($1 IN lower(team."name")) > 0)
         AND ($2::text IS NULL OR lower(team."name") > $2 OR (lower(team."name") = $2 AND team."id" > $3))
       ORDER BY lower(team."name") ASC, team."id" ASC
       LIMIT 21`,
      [normalized, after?.name ?? null, after?.id ?? null],
    );
    const items = rows.slice(0, 20);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > 20 && last ? encodePostgresWebRegistrationCursor({ name: last.name.toLowerCase(), id: last.id }) : null };
  }

  async cursorTeamProviderEntitlements(
    teamId: string,
    cursor?: string,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["cursorTeamProviderEntitlements"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const decoded = cursor ? decodePostgresTeamProviderEntitlementCursor(cursor) : null;
    const rows = await this.rows<Awaited<ReturnType<ApplicationOperationPort["cursorTeamProviderEntitlements"]>>["items"][number]>(
      `SELECT entitlement."id", entitlement."team_id" AS "teamId", entitlement."source_kind" AS "sourceKind",
              entitlement."source_authority_purchase_id" AS "sourceAuthorityPurchaseId",
              entitlement."source_authority_product_id" AS "sourceAuthorityProductId",
              entitlement."source_product_code_snapshot" AS "sourceProductCodeSnapshot",
              entitlement."source_product_version_snapshot" AS "sourceProductVersionSnapshot",
              entitlement."source_product_display_name_snapshot" AS "sourceProductDisplayNameSnapshot",
              entitlement."buyer_user_id" AS "buyerUserId", entitlement."issued_by_user_id" AS "issuedByUserId",
              entitlement."effective_start" AS "effectiveStart", entitlement."effective_end" AS "effectiveEnd",
              entitlement."lifecycle", entitlement."canceled_at" AS "canceledAt",
              entitlement."canceled_by_user_id" AS "canceledByUserId", entitlement."cancel_reason_code" AS "cancelReasonCode",
              entitlement."created_at" AS "createdAt",
              buyer_identity."email" AS "buyerEmail", issuer_identity."email" AS "issuedByEmail", canceler_identity."email" AS "canceledByEmail"
       FROM "team_provider_entitlements" entitlement
       LEFT JOIN "user_controls" buyer ON buyer."id" = entitlement."buyer_user_id"
       LEFT JOIN "user_controls" issuer ON issuer."id" = entitlement."issued_by_user_id"
       LEFT JOIN "user_controls" canceler ON canceler."id" = entitlement."canceled_by_user_id"
       LEFT JOIN "user" buyer_identity ON buyer_identity."id" = buyer."id"
       LEFT JOIN "user" issuer_identity ON issuer_identity."id" = issuer."id"
       LEFT JOIN "user" canceler_identity ON canceler_identity."id" = canceler."id"
       WHERE entitlement."team_id" = $1
         AND ($2::text IS NULL OR entitlement."created_at" < $2 OR (entitlement."created_at" = $2 AND entitlement."id" < $3))
       ORDER BY entitlement."created_at" DESC, entitlement."id" DESC
       LIMIT $4`,
      [teamId, decoded?.createdAt ?? null, decoded?.id ?? null, pageSize + 1],
    );
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items.at(-1);
    return {
      items,
      pageSize,
      hasMore,
      nextCursor: hasMore && last ? encodePostgresTeamProviderEntitlementCursor(last.createdAt, last.id) : null,
    };
  }

  async pageResourcePermissions(
    resourceType: string,
    resourceId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageResourcePermissions"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "resource_permissions" WHERE "resource_type" = $1 AND "resource_id" = $2`,
      [resourceType, resourceId],
    ))?.count ?? 0, "postgres_resource_permission_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageResourcePermissions"]>>["items"][number]>(
      `SELECT "id", "resource_type" AS "resourceType", "resource_id" AS "resourceId", "action",
              "subject_type" AS "subjectType", "subject_ref" AS "subjectRef", "subject_role" AS "subjectRole",
              "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "resource_permissions"
       WHERE "resource_type" = $1 AND "resource_id" = $2
       ORDER BY "action" ASC, "subject_type" ASC, "subject_ref" ASC, COALESCE("subject_role", '') ASC, "id" ASC
       LIMIT $3 OFFSET $4`,
      [resourceType, resourceId, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async searchUserCandidates(query = "", page = 1): Promise<Awaited<ReturnType<ApplicationOperationPort["searchUserCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE user_row."status" = 'enabled'`,
      `SELECT user_row."id", identity."email", user_row."status"`,
      ["user_row.\"id\"", "identity.\"email\""],
      query,
      page,
      `ORDER BY lower(identity."email") ASC, user_row."id" ASC`,
    );
  }

  async searchNonMemberUserCandidates(
    teamId: string,
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchNonMemberUserCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE user_row."status" = 'enabled'
       AND NOT EXISTS (SELECT 1 FROM "team_memberships" membership WHERE membership."team_id" = $1 AND membership."user_id" = user_row."id")`,
      `SELECT user_row."id", identity."email", user_row."status"`,
      ["user_row.\"id\"", "identity.\"email\""],
      query,
      page,
      `ORDER BY lower(identity."email") ASC, user_row."id" ASC`,
      [teamId],
    );
  }

  async searchTeamCandidates(query = "", page = 1): Promise<Awaited<ReturnType<ApplicationOperationPort["searchTeamCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "teams" WHERE "status" = 'enabled'`,
      `SELECT "id", "name", "status"`,
      ["id", "name"],
      query,
      page,
      `ORDER BY lower("name") ASC, "id" ASC`,
    );
  }

  async searchApiKeyCandidates(query = "", page = 1): Promise<Awaited<ReturnType<ApplicationOperationPort["searchApiKeyCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "api_keys" WHERE lower("status") IN ('active', 'enabled', 'healthy')`,
      `SELECT "id", "user_id" AS "userId", "name", "key_prefix" AS "keyPrefix", "status"`,
      ["id", "name", "key_prefix", "user_id"],
      query,
      page,
      `ORDER BY lower("name") ASC, "id" ASC`,
    );
  }

  async searchBudgetPolicyCandidates(query = "", page = 1): Promise<Awaited<ReturnType<ApplicationOperationPort["searchBudgetPolicyCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "budget_policies" WHERE "status" = 'enabled'`,
      `SELECT "id", "metric", "limit_value" AS "limitValue", "window_type" AS "windowType", "window_seconds" AS "windowSeconds", "status"`,
      ["id", "metric", "window_type"],
      query,
      page,
      `ORDER BY "created_at" DESC, "id" DESC`,
    );
  }

  async searchGovernanceBudgetPolicyCandidates(query = "", page = 1): Promise<Awaited<ReturnType<ApplicationOperationPort["searchGovernanceBudgetPolicyCandidates"]>>> {
    return this.pageSimplePostgresCandidates(
      `FROM "governance_budget_policies" WHERE "status" = 'enabled'`,
      `SELECT "id", "metric", "limit_value" AS "limitValue", "window_type" AS "windowType", "window_seconds" AS "windowSeconds", "status"`,
      ["id", "metric", "window_type"],
      query,
      page,
      `ORDER BY "created_at" DESC, "id" DESC`,
    );
  }

  async searchAdminCardCandidates(
    userId: string,
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchAdminCardCandidates"]>>> {
    const pageSize = 20;
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const filter = `FROM "plans" plan
      WHERE plan."plan_status" = 'enabled' AND plan."billing_mode" = 'prepaid' AND plan."duration_seconds" > 0
        AND (plan."scope_ref" = 'global:' OR plan."scope_ref" = 'user:' || $1 OR EXISTS (
          SELECT 1 FROM "team_memberships" membership INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
          WHERE membership."user_id" = $1 AND plan."scope_ref" = 'team:' || membership."team_id"
        ))
        AND ($2 = '' OR position($2 IN lower(plan."id")) > 0 OR position($2 IN lower(plan."name")) > 0)`;
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" ${filter}`, [userId, normalized]))?.count ?? 0, "postgres_admin_card_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchAdminCardCandidates"]>>["items"][number]>(
      `SELECT plan."id", plan."name", plan."version", plan."duration_seconds" AS "durationSeconds" ${filter}
       ORDER BY lower(plan."name") ASC, plan."version" DESC, plan."id" ASC
       LIMIT $3 OFFSET $4`,
      [userId, normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async searchPlanReplacementCandidates(
    sourcePlanId: string,
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchPlanReplacementCandidates"]>>> {
    const pageSize = 20;
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const filter = `FROM "plans" candidate INNER JOIN "plans" source ON source."id" = $1
      WHERE candidate."plan_status" = 'enabled' AND candidate."billing_mode" = 'prepaid'
        AND candidate."name" = source."name" AND candidate."owner_id" = source."owner_id" AND candidate."scope_ref" = source."scope_ref"
        AND candidate."version" > source."version"
        AND ($2 = '' OR position($2 IN lower(candidate."id")) > 0 OR position($2 IN lower(candidate."name")) > 0)`;
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" ${filter}`, [sourcePlanId, normalized]))?.count ?? 0, "postgres_plan_replacement_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchPlanReplacementCandidates"]>>["items"][number]>(
      `SELECT candidate."id", candidate."name", candidate."version", candidate."billing_mode" AS "billingMode", candidate."plan_status" AS "planStatus" ${filter}
       ORDER BY candidate."version" ASC, candidate."id" ASC LIMIT $3 OFFSET $4`,
      [sourcePlanId, normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async searchPlanAccessPointCandidates(query = "", page = 1): Promise<Awaited<ReturnType<ApplicationOperationPort["searchAccessPointCandidates"]>>> {
    const result = await this.pageSimplePostgresCandidates<Awaited<ReturnType<ApplicationOperationPort["searchAccessPointCandidates"]>>["items"][number]>(
      `FROM "access_points" WHERE "status" = 'enabled' AND "removed_at" IS NULL`,
      `SELECT "id", "owner_id" AS "ownerId", "scope_ref" AS "scopeRef", "name", "api_family" AS "apiFamily", "exposed_model" AS "exposedModel", "status"`,
      ["id", "name", "scope_ref", "exposed_model"],
      query,
      page,
      `ORDER BY lower("name") ASC, "id" ASC`,
    );
    const items = await Promise.all(result.items.map(async (item) => ({ ...item, basePrice: await this.findEnabledAccessPointPrice(item.id) ?? null })));
    return { ...result, items };
  }

  async pageOwnerApiKeyDirectory(input: { query?: string; page?: number; pageSize?: number } = {}, at = nowIso()): Promise<import("./queries/pagination.js").PageResult<import("./queries/api-keys.js").OwnerApiKeyDirectoryRow>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "api_keys" key_row INNER JOIN "user_controls" user_row ON user_row."id" = key_row."user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       WHERE $1 = '' OR position($1 IN lower(key_row."id")) > 0 OR position($1 IN lower(key_row."name")) > 0
          OR position($1 IN lower(key_row."key_prefix")) > 0 OR position($1 IN lower(key_row."status")) > 0
          OR position($1 IN lower(key_row."user_id")) > 0 OR position($1 IN lower(identity."email")) > 0`,
      [query],
    ))?.count ?? 0, "postgres_owner_api_key_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<import("./queries/pagination.js").PageResult<import("./queries/api-keys.js").OwnerApiKeyDirectoryRow>["items"][number]>(
      `SELECT key_row."id", key_row."user_id" AS "userId", key_row."name", key_row."key_prefix" AS "keyPrefix", key_row."status", key_row."created_at" AS "createdAt",
              identity."email" AS "userEmail", ('global:, user:' || key_row."user_id") AS "scopeSummary",
              NULL::double precision AS "budgetLimit", NULL::text AS "budgetWindowType", NULL::bigint AS "budgetWindowSeconds",
              COALESCE((SELECT SUM(event."billable_amount") FROM "billing_history_refs" event INNER JOIN (${POSTGRES_REQUEST_IDENTITY_SOURCE}) log ON log."request_id" = event."request_id" WHERE log."api_key_id" = key_row."id"), 0) AS "calculatedCost",
              (SELECT MAX("started_at") FROM (SELECT "started_at" FROM "request_logs" WHERE "api_key_id"=key_row."id" UNION ALL SELECT "started_at" FROM "request_log_archive_entries" WHERE "api_key_id"=key_row."id") used) AS "lastUsedAt"
       FROM "api_keys" key_row INNER JOIN "user_controls" user_row ON user_row."id" = key_row."user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       WHERE $1 = '' OR position($1 IN lower(key_row."id")) > 0 OR position($1 IN lower(key_row."name")) > 0
          OR position($1 IN lower(key_row."key_prefix")) > 0 OR position($1 IN lower(key_row."status")) > 0
          OR position($1 IN lower(key_row."user_id")) > 0 OR position($1 IN lower(identity."email")) > 0
       ORDER BY key_row."created_at" ASC, key_row."id" ASC LIMIT $2 OFFSET $3`,
      [query, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async getOwnerApiKeyDirectoryMetrics(): Promise<import("./queries/api-keys.js").OwnerApiKeyDirectoryMetrics> {
    const row = await this.one<import("./queries/api-keys.js").OwnerApiKeyDirectoryMetrics>(
      `SELECT (SELECT COUNT(*)::int FROM "api_keys") AS "totalKeys",
              (SELECT COUNT(*)::int FROM "api_keys" WHERE lower("status") IN ('active', 'enabled', 'healthy')) AS "activeKeys",
              (SELECT COUNT(*)::int FROM "api_keys" WHERE lower("status") = 'revoked') AS "revokedKeys",
              (SELECT COUNT(DISTINCT "api_key_id")::int FROM "request_logs" WHERE "api_key_id" IS NOT NULL) AS "usedKeys"`,
      [],
    );
    if (!row) throw new Error("postgres_owner_api_key_metrics_empty");
    return row;
  }

  async pageBudgetPolicies(input: { page?: number; pageSize?: number; query?: string; status?: string } = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/budgets.js").BudgetPolicy>> {
    return this.pageSimpleTable("budget_policies", input, ["id", "metric", "window_type"], `SELECT *`, `ORDER BY "created_at" DESC, "id" DESC`) as Promise<import("./queries/pagination.js").PageResult<import("./queries/budgets.js").BudgetPolicy>>;
  }

  async pageScopeBudgetPolicyAssignments(input: { page?: number; pageSize?: number; query?: string; status?: string } = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/budgets.js").DirectBudgetAssignmentRow>> {
    const rows = await this.listScopeBudgetPolicyAssignments();
    const filtered = rows.filter((row) => matchesPostgresDirectoryQuery(row, input.query, [row.id, row.scopeRef, row.budgetPolicyId]) && (!input.status || input.status === "all" || row.status === input.status));
    const items = await Promise.all(filtered.map(async (row) => {
      const apiKey = row.scopeRef.startsWith("key:") ? await this.getApiKey(row.scopeRef.slice("key:".length)) : undefined;
      return { id: row.id, scopeRef: row.scopeRef, budgetPolicyId: row.budgetPolicyId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, apiKeyId: apiKey?.id ?? null, apiKeyName: apiKey?.name ?? null, apiKeyPrefix: apiKey?.keyPrefix ?? null, userId: apiKey?.userId ?? null, policy: row.budgetPolicy };
    }));
    return paginatePostgresArray(items, input.page, input.pageSize);
  }

  async pageGovernanceBudgetPolicies(input: { page?: number; pageSize?: number; query?: string; status?: string } = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/budgets.js").GovernanceBudgetPolicy>> {
    return this.pageSimpleTable("governance_budget_policies", input, ["id", "metric", "window_type"], `SELECT *`, `ORDER BY "created_at" DESC, "id" DESC`) as Promise<import("./queries/pagination.js").PageResult<import("./queries/budgets.js").GovernanceBudgetPolicy>>;
  }

  async pageScopeGovernanceBudgetPolicyAssignments(input: { page?: number; pageSize?: number; query?: string; status?: string } = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/budgets.js").GovernanceBudgetAssignmentRow>> {
    const rows = await this.listScopeGovernanceBudgetPolicyAssignments();
    return paginatePostgresArray(rows.filter((row) => matchesPostgresDirectoryQuery(row, input.query, [row.id, row.scopeRef, row.governanceBudgetPolicyId]) && (!input.status || input.status === "all" || row.status === input.status)), input.page, input.pageSize);
  }

  async listPlanSubscriptionPlanCandidates(search = "", limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionPlanCandidates"]>>> {
    const query = search.trim().toLowerCase();
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionPlanCandidates"]>>["items"][number]>(
      `SELECT "id" AS "value", "name" || ' v' || "version" AS "label", "id" AS "description", "billing_mode" AS "billingMode", "purchase_amount" AS "purchaseAmount", "duration_seconds" AS "durationSeconds"
       FROM "plans" WHERE "plan_status" = 'enabled' AND ($1 = '' OR position($1 IN lower("id" || ' ' || "name")) > 0)
       ORDER BY "name" ASC, "version" DESC, "id" ASC LIMIT $2 OFFSET $3`, [query, limit, offset]);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "plans" WHERE "plan_status" = 'enabled' AND ($1 = '' OR position($1 IN lower("id" || ' ' || "name")) > 0)`, [query]))?.count ?? 0, "postgres_plan_candidate_count_invalid");
    return { items, total };
  }

  async listPlanSubscriptionScopeCandidates(search = "", limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionScopeCandidates"]>>> {
    const query = search.trim().toLowerCase();
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionScopeCandidates"]>>["items"][number]>(
      `WITH candidates AS (
         SELECT 'global:' AS "value", 'Global' AS "label", 'Global scope' AS "description", 0 AS "sortOrder"
         UNION ALL SELECT 'team:' || "id", "name", 'Team', 1 FROM "teams" WHERE "status" = 'enabled'
         UNION ALL SELECT 'user:' || user_row."id", identity."email", 'User', 2
         FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id"
         WHERE user_row."status" = 'enabled'
       ) SELECT "value", "label", "description" FROM candidates WHERE $1 = '' OR position($1 IN lower("value" || ' ' || "label")) > 0
       ORDER BY "sortOrder", "label", "value" LIMIT $2 OFFSET $3`, [query, limit, offset]);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM (SELECT 'global:' AS "value", 'Global' AS "label" UNION ALL SELECT 'team:' || "id", "name" FROM "teams" WHERE "status" = 'enabled' UNION ALL SELECT 'user:' || user_row."id", identity."email" FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE user_row."status" = 'enabled') candidates WHERE $1 = '' OR position($1 IN lower("value" || ' ' || "label")) > 0`, [query]))?.count ?? 0, "postgres_scope_candidate_count_invalid");
    return { items, total };
  }

  async listPlanSubscriptionAccountCandidates(search = "", limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionAccountCandidates"]>>> {
    const query = search.trim().toLowerCase();
    const items = await this.rows<{ value: string; label: string; description: string; balanceUnits: number }>(
      `SELECT "id" AS "value", "scope_ref" AS "label", "id" AS "description", "balance_snap_units" AS "balanceUnits"
       FROM "credit_accounts" WHERE "status" = 'active' AND ($1 = '' OR position($1 IN lower("id" || ' ' || "scope_ref")) > 0)
       ORDER BY "scope_ref", "id" LIMIT $2 OFFSET $3`, [query, limit, offset]);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_accounts" WHERE "status" = 'active' AND ($1 = '' OR position($1 IN lower("id" || ' ' || "scope_ref")) > 0)`, [query]))?.count ?? 0, "postgres_account_candidate_count_invalid");
    return { items: items.map(({ balanceUnits, ...row }) => ({ ...row, balance: creditUnitsToUsd(Number(balanceUnits)) })), total };
  }

  async listPlanSubscriptionUserCandidates(subscriptionId: string, search = "", limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionUserCandidates"]>>> {
    const subscription = await this.one<PlanSubscription>(`SELECT * FROM "plan_subscriptions" WHERE "id" = $1`, [subscriptionId]);
    if (!subscription) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
    const query = search.trim().toLowerCase();
    const scopeType = subscription.scopeRef.split(":", 1)[0];
    const scopeId = subscription.scopeRef.slice(subscription.scopeRef.indexOf(":") + 1);
    const scopeClause = scopeType === "global" ? `user_row."status" = 'enabled'` : scopeType === "user" ? `user_row."id" = $1 AND user_row."status" = 'enabled'` : `user_row."status" = 'enabled' AND EXISTS (SELECT 1 FROM "team_memberships" membership INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled' WHERE membership."user_id" = user_row."id" AND membership."team_id" = $1)`;
    const queryParam = scopeType === "global" ? 1 : 2;
    const values = scopeType === "global" ? [query] : [scopeId, query];
    const filter = `${scopeClause} AND ($${queryParam} = '' OR position($${queryParam} IN lower(user_row."id" || ' ' || identity."email")) > 0)`;
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["listPlanSubscriptionUserCandidates"]>>["items"][number]>(`SELECT user_row."id" AS "value", identity."email" AS "label", user_row."id" || ' · ' || user_row."status" AS "description" FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE ${filter} ORDER BY identity."email", user_row."id" LIMIT $${queryParam + 1} OFFSET $${queryParam + 2}`, [...values, limit, offset]);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE ${filter}`, values))?.count ?? 0, "postgres_subscription_user_candidate_count_invalid");
    return { items, total };
  }

  async listAdminGrantUserCandidates(search = "", limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantUserCandidates"]>>> {
    const query = search.trim().toLowerCase();
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantUserCandidates"]>>["items"][number]>(`SELECT user_row."id" AS "value", identity."email" AS "label", user_row."id" || ' · enabled' AS "description" FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE user_row."status" = 'enabled' AND ($1 = '' OR position($1 IN lower(user_row."id" || ' ' || identity."email")) > 0) ORDER BY identity."email", user_row."id" LIMIT $2 OFFSET $3`, [query, Math.min(Math.max(1, Math.trunc(limit)), 20), Math.max(0, Math.trunc(offset))]);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "user_controls" user_row INNER JOIN "user" identity ON identity."id" = user_row."id" WHERE user_row."status" = 'enabled' AND ($1 = '' OR position($1 IN lower(user_row."id" || ' ' || identity."email")) > 0)`, [query]))?.count ?? 0, "postgres_admin_grant_user_count_invalid");
    return { items, total };
  }

  async listAdminGrantCreditProductCandidates(search = "", limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantCreditProductCandidates"]>>> {
    const query = search.trim().toLowerCase();
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantCreditProductCandidates"]>>["items"][number]>(`SELECT "id" AS "value", "display_name" AS "label", "code" || ' · ' || "credited_amount_units" || ' units' AS "description" FROM "credit_products" WHERE "status" = 'enabled' AND ($1 = '' OR position($1 IN lower("id" || ' ' || "code" || ' ' || "display_name")) > 0) ORDER BY "display_order", "code", "id" LIMIT $2 OFFSET $3`, [query, limit, offset]);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_products" WHERE "status" = 'enabled' AND ($1 = '' OR position($1 IN lower("id" || ' ' || "code" || ' ' || "display_name")) > 0)`, [query]))?.count ?? 0, "postgres_credit_product_candidate_count_invalid");
    return { items, total };
  }

  async countAdminGrantBatches(): Promise<number> {
    return safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "admin_grant_batches"`, []))?.count ?? 0, "postgres_admin_grant_batch_count_invalid");
  }

  async listAdminGrantBatches(limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantBatches"]>>> {
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantBatches"]>>[number]>(
      `SELECT * FROM "admin_grant_batches" ORDER BY "created_at" DESC, "id" DESC LIMIT $1 OFFSET $2`,
      [normalizeDirectoryPageSize(limit), Math.max(0, Math.trunc(offset))],
    );
  }

  async getAdminGrantBatchDetail(id: string, limit = 20, offset = 0): Promise<Awaited<ReturnType<ApplicationOperationPort["getAdminGrantBatchDetail"]>>> {
    type Detail = NonNullable<Awaited<ReturnType<ApplicationOperationPort["getAdminGrantBatchDetail"]>>>;
    const batch = await this.one<Detail["batch"]>(`SELECT * FROM "admin_grant_batches" WHERE "id" = $1`, [id]);
    if (!batch) return undefined;
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "admin_grant_batch_items" WHERE "batch_id" = $1`, [id]))?.count ?? 0, "postgres_admin_grant_item_count_invalid");
    const items = await this.rows<Detail["items"][number]>(
      `SELECT item.*, identity."email" AS "targetEmail"
       FROM "admin_grant_batch_items" item INNER JOIN "user_controls" user_row ON user_row."id" = item."target_user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       WHERE item."batch_id" = $1 ORDER BY item."processed_at" ASC, item."id" ASC LIMIT $2 OFFSET $3`,
      [id, normalizeDirectoryPageSize(limit), Math.max(0, Math.trunc(offset))],
    );
    return { batch, items, total };
  }

  async pageUserAuthorityGrants(
    userId: string,
    page = 1,
    at = nowIso(),
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserAuthorityGrants"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const filter = `
      WHERE authority_grant."beneficiary_user_id" = $1
        AND authority_grant."role_domain" = 'platform'
        AND authority_grant."role_code" = 'creator'`;
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "authority_grants" authority_grant
       ${filter}`,
      [userId],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_authority_grant_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageUserAuthorityGrants"]>>["items"][number]>(
      `SELECT authority_grant."id", authority_grant."source_kind" AS "sourceKind",
              authority_grant."source_product_code_snapshot" AS "productCode",
              authority_grant."source_product_version_snapshot" AS "productVersion",
              authority_grant."effective_start" AS "effectiveStart",
              authority_grant."effective_end" AS "effectiveEnd", authority_grant."lifecycle",
              quota."capability_code" AS "capabilityCode", quota."granted_units" AS "grantedUnits",
              (SELECT COUNT(*)::int FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id") AS "usedUnits",
              CASE
                WHEN authority_grant."lifecycle" = 'active' AND authority_grant."effective_start" <= $2
                  AND (authority_grant."effective_end" IS NULL OR authority_grant."effective_end" > $2)
                THEN GREATEST(0, quota."granted_units" - (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id"))
                ELSE 0
              END AS "availableUnits"
       FROM "authority_grants" authority_grant
       INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = authority_grant."id"
       ${filter}
       ORDER BY COALESCE(authority_grant."effective_end", '9999-12-31T23:59:59.999Z') ASC,
                authority_grant."created_at" ASC, authority_grant."id" ASC
       LIMIT $3 OFFSET $4`,
      [userId, at, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async hasAvailableUserGrant(userId: string, at = nowIso()): Promise<Awaited<ReturnType<ApplicationOperationPort["hasAvailableUserGrant"]>>> {
    const row = await this.one<{ id: string }>(
      `SELECT authority_grant."id"
       FROM "authority_grants" authority_grant
       INNER JOIN "authority_grant_quotas" quota ON quota."grant_id" = authority_grant."id"
       WHERE authority_grant."beneficiary_user_id" = $1
         AND authority_grant."role_domain" = 'platform'
         AND authority_grant."role_code" = 'creator'
         AND authority_grant."lifecycle" = 'active'
         AND authority_grant."effective_start" <= $2
         AND (authority_grant."effective_end" IS NULL OR authority_grant."effective_end" > $2)
         AND quota."granted_units" > (SELECT COUNT(*) FROM "authority_uses" use_row WHERE use_row."grant_quota_id" = quota."id")
       LIMIT 1`,
      [userId, at],
    );
    return Boolean(row);
  }

  async purchaseAuthorityProduct(input: { buyerUserId: string; productId: string; idempotencyKey: string }): Promise<AuthorityPurchaseResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ productId: input.productId }));
      const existing = await transaction.one<AuthorityPurchase>(
        `SELECT * FROM "authority_purchases"
         WHERE "buyer_user_id" = $1 AND "idempotency_key_hash" = $2
         FOR UPDATE`,
        [input.buyerUserId, idempotencyKeyHash],
      );
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority purchase", 409);
        const grant = await transaction.one<AuthorityGrant>(`SELECT * FROM "authority_grants" WHERE "source_purchase_id" = $1`, [existing.id]);
        if (!grant) throw new RelayError("authority_purchase_corrupt", "Authority Purchase Grant is missing", 500);
        const quota = await transaction.one<AuthorityGrantQuota>(`SELECT * FROM "authority_grant_quotas" WHERE "grant_id" = $1`, [grant.id]);
        if (!quota) throw new RelayError("authority_purchase_corrupt", "Authority Purchase quota is missing", 500);
        return { purchase: existing, grant, quota, replayed: true };
      }

      const buyer = await transaction.one<{ id: string; status: string }>(`SELECT "id", "status" FROM "user_controls" WHERE "id" = $1 FOR UPDATE`, [input.buyerUserId]);
      if (!buyer || buyer.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const product = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1 FOR UPDATE`, [input.productId]);
      if (!product || product.lifecycle !== "listed") throw new RelayError("authority_product_not_purchasable", "Authority Product is not purchasable", 409);
      await transaction.assertPostgresAuthorityPurchaseLimits(product, buyer.id, nowIso());
      const account = await transaction.findCreditAccountForScope(userScopeRef(buyer.id)) ?? await transaction.createCreditAccount({ scopeRef: userScopeRef(buyer.id) });
      if (account.status !== "active") throw new RelayError("credit_account_not_found", "An active personal credit account is required", 404);

      const createdAt = nowIso();
      const purchase = await transaction.insertPostgresAuthorityPurchase({ product, buyerUserId: buyer.id, creditAccountId: account.id, idempotencyKeyHash, requestHash, createdAt });
      const ledger = await transaction.createCreditLedgerEvent({
        accountId: account.id, eventType: "authority_purchase", amountUnits: -purchase.purchaseAmountUnits,
        transferId: null, relatedEventId: null, planSubscriptionId: null, authorityPurchaseId: purchase.id,
        billingEventId: null, fromAccountId: account.id, toAccountId: null,
        reason: `authority_product:${purchase.productCode}@${purchase.productVersion}`, actorUserId: buyer.id, createdAt,
      });
      const grant: AuthorityGrant = {
        id: createId("authority_grant"), beneficiaryUserId: buyer.id, roleDomain: "platform", roleCode: "creator", roleScopeId: null,
        sourceKind: "product_purchase", sourcePurchaseId: purchase.id, sourceProductCodeSnapshot: purchase.productCode,
        sourceProductVersionSnapshot: purchase.productVersion, sourceOriginIdSnapshot: purchase.id,
        maxCurrentOwnedTeamsSnapshot: purchase.maxCurrentOwnedTeams, maxLifetimeCreatedTeamsSnapshot: purchase.maxLifetimeCreatedTeams,
        issuedByUserId: product.createdByOwnerUserId, effectiveStart: createdAt, effectiveEnd: postgresAddSeconds(createdAt, purchase.grantDurationSeconds), lifecycle: "active",
        canceledAt: null, canceledByUserId: null, cancelReasonCode: null, createdAt,
      };
      const quota: AuthorityGrantQuota = { id: createId("authority_quota"), grantId: grant.id, capabilityCode: "team.create", grantedUnits: purchase.grantUnits, createdAt };
      await transaction.insertRow<AuthorityGrant>("authority_grants", grant);
      await transaction.insertRow<AuthorityGrantQuota>("authority_grant_quotas", quota);
      const releaseAt = postgresAddSeconds(createdAt, purchase.settlementHoldSeconds);
      await transaction.insertSellerSettlementEvent({
        authorityPurchaseId: purchase.id, sellerScopeRef: purchase.sellerScopeRef as ScopeRef,
        windowStart: createdAt, windowEnd: releaseAt, releaseAt, eventType: "revenue",
        amountUnits: purchase.purchaseAmountUnits, sourceType: "authority_purchase", sourceId: ledger.id, createdAt,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: buyer.id }, action: "authority_purchase.create", resource: { resourceType: "authority_purchase", resourceId: purchase.id }, result: "success", source: "web", metadata: { productId: product.id, productCode: product.code, productVersion: product.version, grantUnits: product.grantUnits, purchaseAmountUnits: product.purchaseAmountUnits } });
      return { purchase, grant, quota, replayed: false };
    });
  }

  async purchaseTeamProviderAuthorityProduct(input: { buyerUserId: string; productId: string; teamId: string; idempotencyKey: string }): Promise<AuthorityTeamProviderPurchaseResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ productId: input.productId, teamId: input.teamId }));
      const existing = await transaction.one<AuthorityPurchase>(
        `SELECT * FROM "authority_purchases"
         WHERE "buyer_user_id" = $1 AND "idempotency_key_hash" = $2
         FOR UPDATE`,
        [input.buyerUserId, idempotencyKeyHash],
      );
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Authority purchase", 409);
        const entitlement = await transaction.one<TeamProviderEntitlement>(`SELECT * FROM "team_provider_entitlements" WHERE "source_authority_purchase_id" = $1`, [existing.id]);
        if (!entitlement) throw new RelayError("authority_purchase_corrupt", "Authority Purchase Team Provider entitlement is missing", 500);
        return { purchase: existing, entitlement, replayed: true };
      }

      const buyer = await transaction.one<{ id: string; status: string }>(`SELECT "id", "status" FROM "user_controls" WHERE "id" = $1 FOR UPDATE`, [input.buyerUserId]);
      if (!buyer || buyer.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const team = await transaction.one<Team>(`SELECT * FROM "teams" WHERE "id" = $1 FOR UPDATE`, [input.teamId]);
      if (!team || team.status !== "enabled") throw new RelayError("team_not_found", "Enabled Team not found", 404);
      const membership = await transaction.getTeamMembership(team.id, buyer.id);
      const roles = parseJsonText<string[]>(membership?.rolesJson ?? "[]", []);
      if (team.ownerId !== buyer.id && !(Array.isArray(roles) && roles.includes("billing"))) {
        throw new RelayError("team_provider_purchase_forbidden", "Team Owner or Billing membership is required", 403);
      }
      const product = await transaction.one<AuthorityProduct>(`SELECT * FROM "authority_products" WHERE "id" = $1 FOR UPDATE`, [input.productId]);
      if (!product || product.lifecycle !== "listed" || product.effectCode !== "team_custom_provider_access") {
        throw new RelayError("authority_product_not_purchasable", "Authority Product is not purchasable for Team Provider access", 409);
      }
      const permanent = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "team_provider_entitlements"
         WHERE "team_id" = $1 AND "lifecycle" = 'active' AND "effective_end" IS NULL LIMIT 1`,
        [team.id],
      );
      if (permanent) throw new RelayError("team_provider_entitlement_permanent", "Team already has permanent Provider access", 409);
      await transaction.assertPostgresAuthorityPurchaseLimits(product, buyer.id, nowIso());
      const account = await transaction.findCreditAccountForScope(userScopeRef(buyer.id)) ?? await transaction.createCreditAccount({ scopeRef: userScopeRef(buyer.id) });
      if (account.status !== "active") throw new RelayError("credit_account_not_found", "An active personal credit account is required", 404);

      const createdAt = nowIso();
      const purchase = await transaction.insertPostgresAuthorityPurchase({ product, buyerUserId: buyer.id, creditAccountId: account.id, idempotencyKeyHash, requestHash, createdAt });
      const ledger = await transaction.createCreditLedgerEvent({
        accountId: account.id, eventType: "authority_purchase", amountUnits: -purchase.purchaseAmountUnits,
        transferId: null, relatedEventId: null, planSubscriptionId: null, authorityPurchaseId: purchase.id,
        billingEventId: null, fromAccountId: account.id, toAccountId: null,
        reason: `authority_product:${purchase.productCode}@${purchase.productVersion}`, actorUserId: buyer.id, createdAt,
      });
      const latest = await transaction.one<{ effectiveEnd: string | null }>(
        `SELECT max("effective_end") AS "effectiveEnd" FROM "team_provider_entitlements"
         WHERE "team_id" = $1 AND "lifecycle" = 'active' AND "effective_end" IS NOT NULL AND "effective_end" > $2`,
        [team.id, createdAt],
      );
      const effectiveStart = latest?.effectiveEnd ?? createdAt;
      const entitlement: TeamProviderEntitlement = {
        id: createId("team_provider_entitlement"), teamId: team.id, sourceKind: "product_purchase",
        sourceAuthorityPurchaseId: purchase.id, sourceAuthorityProductId: product.id,
        sourceProductCodeSnapshot: purchase.productCode, sourceProductVersionSnapshot: purchase.productVersion,
        sourceProductDisplayNameSnapshot: purchase.productDisplayName, buyerUserId: buyer.id, issuedByUserId: null,
        effectiveStart, effectiveEnd: postgresAddSeconds(effectiveStart, purchase.grantDurationSeconds), lifecycle: "active",
        canceledAt: null, canceledByUserId: null, cancelReasonCode: null, idempotencyKeyHash: null, requestHash: null, createdAt,
      };
      await transaction.insertRow<TeamProviderEntitlement>("team_provider_entitlements", entitlement);
      const releaseAt = postgresAddSeconds(createdAt, purchase.settlementHoldSeconds);
      await transaction.insertSellerSettlementEvent({
        authorityPurchaseId: purchase.id, sellerScopeRef: purchase.sellerScopeRef as ScopeRef,
        windowStart: createdAt, windowEnd: releaseAt, releaseAt, eventType: "revenue",
        amountUnits: purchase.purchaseAmountUnits, sourceType: "authority_purchase", sourceId: ledger.id, createdAt,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: buyer.id }, action: "team_provider_entitlement.purchase", resource: { resourceType: "team_provider_entitlement", resourceId: entitlement.id }, result: "success", source: "web", metadata: { teamId: team.id, productId: product.id, productCode: product.code, productVersion: product.version, purchaseAmountUnits: product.purchaseAmountUnits, effectiveStart: entitlement.effectiveStart, effectiveEnd: entitlement.effectiveEnd } });
      return { purchase, entitlement, replayed: false };
    });
  }

  async createAuthorityTeam(input: { beneficiaryUserId: string; name: string; idempotencyKey: string }): Promise<AuthorityTeamCreateResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const name = postgresRequiredTrimmed(input.name, "name", 120);
      const requestHash = postgresSha256Text(JSON.stringify({ name }));
      const existing = await transaction.one<AuthorityUse>(
        `SELECT * FROM "authority_uses"
         WHERE "beneficiary_user_id" = $1 AND "operation" = 'team.create' AND "idempotency_key_hash" = $2
         FOR UPDATE`,
        [input.beneficiaryUserId, idempotencyKeyHash],
      );
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RelayError("authority_idempotency_conflict", "Idempotency key was already used with a different Team request", 409);
        const team = await transaction.getTeam(existing.targetIdSnapshot);
        return { use: existing, targetStatus: team?.status === "enabled" && team.ownerId === existing.beneficiaryUserId ? "active" : "unavailable", replayed: true };
      }
      const beneficiary = await transaction.one<{ id: string; status: string }>(`SELECT "id", "status" FROM "user_controls" WHERE "id" = $1 FOR UPDATE`, [input.beneficiaryUserId]);
      if (!beneficiary || beneficiary.status !== "enabled") throw new RelayError("user_not_found", "Enabled user not found", 404);
      const now = nowIso();
      const candidates = await transaction.rows<{ quotaId: string; grantId: string; grantedUnits: number; maxCurrentOwnedTeams: number | null; maxLifetimeCreatedTeams: number | null; sourceProductCode: string | null }>(
        `SELECT q."id" AS "quotaId", q."granted_units" AS "grantedUnits", g."id" AS "grantId",
                g."max_current_owned_teams_snapshot" AS "maxCurrentOwnedTeams",
                g."max_lifetime_created_teams_snapshot" AS "maxLifetimeCreatedTeams",
                g."source_product_code_snapshot" AS "sourceProductCode"
         FROM "authority_grants" g
         INNER JOIN "authority_grant_quotas" q ON q."grant_id" = g."id"
         WHERE g."beneficiary_user_id" = $1 AND g."role_domain" = 'platform' AND g."role_code" = 'creator'
           AND g."lifecycle" = 'active' AND g."effective_start" <= $2
           AND (g."effective_end" IS NULL OR g."effective_end" > $2)
           AND q."capability_code" = 'team.create'
           AND q."granted_units" > (SELECT COUNT(*) FROM "authority_uses" u WHERE u."grant_quota_id" = q."id")
         ORDER BY COALESCE(g."effective_end", '9999-12-31T23:59:59.999Z') ASC, g."effective_start" ASC, g."created_at" ASC, g."id" ASC
         FOR UPDATE OF g, q`,
        [beneficiary.id, now],
      );
      if (candidates.length === 0) {
        const states = await transaction.rows<{ lifecycle: string; effectiveEnd: string | null }>(
          `SELECT "lifecycle", "effective_end" AS "effectiveEnd" FROM "authority_grants"
           WHERE "beneficiary_user_id" = $1 AND "role_domain" = 'platform' AND "role_code" = 'creator'`,
          [beneficiary.id],
        );
        if (states.length > 0 && states.every((grant) => grant.lifecycle === "canceled")) throw new RelayError("authority_grant_canceled", "Every Team creation Grant is canceled", 409);
        if (states.some((grant) => grant.lifecycle === "active" && grant.effectiveEnd !== null && grant.effectiveEnd <= now)) throw new RelayError("authority_grant_expired", "Every remaining Team creation Grant is expired", 409);
        throw new RelayError("authority_quota_exhausted", "No active Team creation unit is available", 409);
      }
      const currentOwned = Number((await transaction.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "teams" WHERE "owner_id" = $1 AND "status" = 'enabled'`, [beneficiary.id]))?.count ?? 0);
      const lifetimeCreated = Number((await transaction.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "authority_uses" WHERE "beneficiary_user_id" = $1 AND "operation" = 'team.create'`, [beneficiary.id]))?.count ?? 0);
      if (currentOwned >= AUTHORITY_PRODUCT_LIMITS.maxTeamLimit || lifetimeCreated >= AUTHORITY_PRODUCT_LIMITS.maxTeamLimit) throw new RelayError("authority_team_limit_exceeded", "Platform Team creation safety limit reached", 409);
      let selected: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        const lifetimeForProduct = Number((await transaction.one<{ count: number }>(
          `SELECT COUNT(*)::int AS "count"
           FROM "authority_uses" u
           INNER JOIN "authority_grant_quotas" q ON q."id" = u."grant_quota_id"
           INNER JOIN "authority_grants" g ON g."id" = q."grant_id"
           WHERE u."beneficiary_user_id" = $1 AND g."source_product_code_snapshot" IS NOT DISTINCT FROM $2`,
          [beneficiary.id, candidate.sourceProductCode],
        ))?.count ?? 0);
        if (candidate.maxCurrentOwnedTeams !== null && currentOwned >= candidate.maxCurrentOwnedTeams) continue;
        if (candidate.maxLifetimeCreatedTeams !== null && lifetimeForProduct >= candidate.maxLifetimeCreatedTeams) continue;
        selected = candidate;
        break;
      }
      if (!selected) throw new RelayError("authority_team_limit_exceeded", "Every available Team creation unit is blocked by its frozen Team limit", 409);
      const used = Number((await transaction.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "authority_uses" WHERE "grant_quota_id" = $1`, [selected.quotaId]))?.count ?? 0);
      const team = await transaction.upsertTeam({ name, ownerId: beneficiary.id });
      await transaction.grantTeamMembership(team.id, beneficiary.id);
      const use: AuthorityUse = {
        id: createId("authority_use"), grantQuotaId: selected.quotaId, unitIndex: used + 1,
        beneficiaryUserId: beneficiary.id, operation: "team.create", idempotencyKeyHash, requestHash,
        targetType: "team", targetIdSnapshot: team.id, actorUserId: beneficiary.id, createdAt: nowIso(),
      };
      await transaction.insertRow<AuthorityUse>("authority_uses", use);
      await transaction.audit({ actor: { actorType: "user", actorId: beneficiary.id }, action: "team.create", resource: { resourceType: "team", resourceId: team.id }, result: "success", source: "web", metadata: { authorityUseId: use.id, grantQuotaId: use.grantQuotaId, ownerId: beneficiary.id } });
      return { use, targetStatus: "active", replayed: false };
    });
  }

  async pageUserCreditCatalog(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserCreditCatalog"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "credit_products" WHERE "status" = 'enabled'`,
      [],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_credit_product_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    type CatalogProduct = Awaited<ReturnType<ApplicationOperationPort["pageUserCreditCatalog"]>>["items"][number];
    type CatalogListing = CatalogProduct["listings"][number];
    const products = await this.rows<Omit<CatalogProduct, "listings" | "listingTotal" | "listingHasMore">>(
      `SELECT "id", "code", "display_name" AS "displayName", "description",
              "credited_amount_units" AS "creditedAmountUnits", "status",
              "display_order" AS "displayOrder", "created_at" AS "createdAt"
       FROM "credit_products"
       WHERE "status" = 'enabled'
       ORDER BY "display_order" ASC, "created_at" ASC, "id" ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    const listingsByProduct = new Map<string, { items: CatalogListing[]; total: number }>();
    if (products.length > 0) {
      const productIds = products.map((product) => product.id);
      const placeholders = productIds.map((_, index) => `$${index + 1}`).join(", ");
      const listings = await this.rows<CatalogListing & {
        channelCode: string;
        channelDisplayName: string;
        channelPaymentNetwork: string;
        channelPaymentAsset: string;
        channelSettlementMode: string;
        channelRecipientIdentifierType: string;
        channelTransactionReferenceType: string;
        channelRecipientIdentifierDisplay: string;
        channelPaymentInstruction: string | null;
        channelStatus: string;
        listingPosition: number;
        listingTotal: number;
      }>(
        `WITH ranked AS (
           SELECT listing."id", listing."product_id" AS "productId",
                  listing."payment_channel_id" AS "paymentChannelId",
                  listing."price_amount_units" AS "priceAmountUnits", listing."status",
                  channel."code" AS "channelCode", channel."display_name" AS "channelDisplayName",
                  channel."payment_network" AS "channelPaymentNetwork", channel."payment_asset" AS "channelPaymentAsset",
                  channel."settlement_mode" AS "channelSettlementMode",
                  channel."recipient_identifier_type" AS "channelRecipientIdentifierType",
                  channel."transaction_reference_type" AS "channelTransactionReferenceType",
                  channel."recipient_identifier_display" AS "channelRecipientIdentifierDisplay",
                  channel."payment_instruction" AS "channelPaymentInstruction",
                  channel."status" AS "channelStatus",
                  ROW_NUMBER() OVER (PARTITION BY listing."product_id" ORDER BY listing."created_at" ASC, listing."id" ASC) AS "listingPosition",
                  COUNT(*) OVER (PARTITION BY listing."product_id") AS "listingTotal"
           FROM "credit_product_listings" listing
           INNER JOIN "payment_channels" channel ON channel."id" = listing."payment_channel_id"
           WHERE listing."status" = 'enabled'
             AND channel."status" = 'enabled'
             AND channel."settlement_mode" IN ('manual_review', 'stripe_checkout')
             AND listing."product_id" IN (${placeholders})
         )
         SELECT * FROM ranked
         WHERE "listingPosition" <= 20
         ORDER BY "productId" ASC, "listingPosition" ASC, "id" ASC`,
        productIds,
      );
      const channelIds = [...new Set(listings.map((listing) => listing.paymentChannelId))];
      const attachmentsByChannel = new Map<string, { items: CatalogListing["paymentChannel"]["instructionAttachments"]; total: number }>();
      if (channelIds.length > 0) {
        const channelPlaceholders = channelIds.map((_, index) => `$${index + 1}`).join(", ");
        const attachments = await this.rows<{
          id: string;
          paymentChannelId: string;
          contentType: string;
          byteSize: number;
          attachmentPosition: number;
          attachmentTotal: number;
        }>(
          `WITH ranked AS (
             SELECT "id", "payment_channel_id" AS "paymentChannelId", "content_type" AS "contentType",
                    "byte_size" AS "byteSize",
                    ROW_NUMBER() OVER (PARTITION BY "payment_channel_id" ORDER BY "created_at" ASC, "id" ASC) AS "attachmentPosition",
                    COUNT(*) OVER (PARTITION BY "payment_channel_id") AS "attachmentTotal"
             FROM "payment_channel_instruction_attachments"
             WHERE "payment_channel_id" IN (${channelPlaceholders})
           )
           SELECT * FROM ranked
           WHERE "attachmentPosition" <= 20
           ORDER BY "paymentChannelId" ASC, "attachmentPosition" ASC, "id" ASC`,
          channelIds,
        );
        for (const attachment of attachments) {
          const current = attachmentsByChannel.get(attachment.paymentChannelId) ?? { items: [], total: attachment.attachmentTotal };
          current.items.push({ id: attachment.id, contentType: attachment.contentType, byteSize: attachment.byteSize });
          attachmentsByChannel.set(attachment.paymentChannelId, current);
        }
      }
      for (const listing of listings) {
        const attachments = attachmentsByChannel.get(listing.paymentChannelId) ?? { items: [], total: 0 };
        const current = listingsByProduct.get(listing.productId) ?? { items: [], total: listing.listingTotal };
        current.items.push({
          id: listing.id,
          productId: listing.productId,
          paymentChannelId: listing.paymentChannelId,
          priceAmountUnits: listing.priceAmountUnits,
          status: listing.status,
          paymentChannel: {
            id: listing.paymentChannelId,
            code: listing.channelCode,
            displayName: listing.channelDisplayName,
            paymentNetwork: listing.channelPaymentNetwork,
            paymentAsset: listing.channelPaymentAsset,
            settlementMode: listing.channelSettlementMode,
            recipientIdentifierType: listing.channelRecipientIdentifierType,
            transactionReferenceType: listing.channelTransactionReferenceType,
            recipientIdentifierDisplay: listing.channelRecipientIdentifierDisplay,
            paymentInstruction: listing.channelPaymentInstruction,
            status: listing.channelStatus,
            instructionAttachments: attachments.items,
            attachmentTotal: attachments.total,
            attachmentHasMore: attachments.total > attachments.items.length,
          },
        });
        listingsByProduct.set(listing.productId, current);
      }
    }
    const items = products.map((product): CatalogProduct => {
      const related = listingsByProduct.get(product.id) ?? { items: [], total: 0 };
      return { ...product, listings: related.items, listingTotal: related.total, listingHasMore: related.total > related.items.length };
    });
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageCreditAccounts(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageCreditAccounts"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_accounts"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_credit_account_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageCreditAccounts"]>>["items"][number]>(
      `SELECT "id", "scope_ref" AS "scopeRef", "status",
              "balance_snap_units" AS "balanceSnapUnits",
              "balance_snap_ledger_event_id" AS "balanceSnapLedgerEventId",
              "balance_snap_updated_at" AS "balanceSnapUpdatedAt",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "credit_accounts"
       ORDER BY lower("scope_ref") ASC, "id" ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    const normalizedItems = items.map((row) => ({
      ...row,
      balanceSnapUnits: safePostgresInteger(row.balanceSnapUnits, "postgres_credit_account_balance_units_invalid"),
    }));
    return { items: normalizedItems, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageAdminCreditUserAccounts(input: { page?: number; pageSize?: number; query?: string } = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCreditAccountDirectoryRow>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const filter = `$1 = '' OR position($1 IN lower(identity."email")) > 0 OR position($1 IN lower(user_row."id")) > 0
      OR position($1 IN lower(COALESCE(team."name", ''))) > 0 OR position($1 IN lower(COALESCE(team."id", ''))) > 0
      OR position($1 IN lower(COALESCE(account."id", ''))) > 0 OR position($1 IN lower(COALESCE(account."status", 'not_created'))) > 0`;
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "user_controls" user_row
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       LEFT JOIN "credit_accounts" account ON account."scope_ref" = 'user:' || user_row."id"
       LEFT JOIN "teams" team ON team."id" = (
         SELECT membership."team_id" FROM "team_memberships" membership
         INNER JOIN "teams" membership_team ON membership_team."id" = membership."team_id"
         WHERE membership."user_id" = user_row."id" AND membership_team."status" = 'enabled'
         ORDER BY membership."created_at" ASC, membership."id" ASC LIMIT 1
       )
       WHERE ${filter}`,
      [query],
    ))?.count ?? 0, "postgres_admin_credit_user_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCreditAccountDirectoryRow>["items"][number]>(
      `SELECT user_row."id" AS "userId", identity."email" AS "userEmail", team."id" AS "teamId", team."name" AS "teamName",
              account."id" AS "accountId", COALESCE(account."balance_snap_units", 0) AS "balanceSnapUnits",
              COALESCE(policy."transfer_out_enabled", 1) AS "transferOutEnabled",
              COALESCE(account."status", 'not_created') AS "accountStatus",
              (SELECT ledger."created_at" FROM "credit_ledger_events" ledger WHERE ledger."account_id" = account."id" ORDER BY ledger."created_at" DESC, ledger."id" DESC LIMIT 1) AS "latestLedgerAt"
       FROM "user_controls" user_row
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       LEFT JOIN "credit_accounts" account ON account."scope_ref" = 'user:' || user_row."id"
       LEFT JOIN "credit_transfer_policies" policy ON policy."scope_ref" = 'user:' || user_row."id"
       LEFT JOIN "teams" team ON team."id" = (
         SELECT membership."team_id" FROM "team_memberships" membership
         INNER JOIN "teams" membership_team ON membership_team."id" = membership."team_id"
         WHERE membership."user_id" = user_row."id" AND membership_team."status" = 'enabled'
         ORDER BY membership."created_at" ASC, membership."id" ASC LIMIT 1
       )
       WHERE ${filter}
       ORDER BY lower(identity."email") ASC, user_row."id" ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, (page - 1) * pageSize],
    );
    const normalizedItems = items.map((row) => ({
      ...row,
      balanceSnapUnits: safePostgresInteger(row.balanceSnapUnits, "postgres_admin_credit_user_balance_units_invalid"),
    }));
    return { items: normalizedItems, page, pageSize, total, totalPages };
  }

  async pageAdminNonUserCreditAccounts(input: { page?: number; pageSize?: number; query?: string } = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/credits.js").NonUserCreditAccountDirectoryRow>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const filter = `$1 = '' OR position($1 IN lower(account."scope_ref")) > 0 OR position($1 IN lower(account."id")) > 0 OR position($1 IN lower(account."status")) > 0`;
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "credit_accounts" account WHERE account."scope_ref" NOT LIKE 'user:%' AND (${filter})`,
      [query],
    ))?.count ?? 0, "postgres_admin_credit_non_user_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<import("./queries/pagination.js").PageResult<import("./queries/credits.js").NonUserCreditAccountDirectoryRow>["items"][number]>(
      `SELECT account."id", account."scope_ref" AS "scopeRef", account."balance_snap_units" AS "balanceSnapUnits", account."status",
              (SELECT ledger."created_at" FROM "credit_ledger_events" ledger WHERE ledger."account_id" = account."id" ORDER BY ledger."created_at" DESC, ledger."id" DESC LIMIT 1) AS "latestLedgerAt"
       FROM "credit_accounts" account
       WHERE account."scope_ref" NOT LIKE 'user:%' AND (${filter})
       ORDER BY lower(account."scope_ref") ASC, account."id" ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, (page - 1) * pageSize],
    );
    const normalizedItems = items.map((row) => ({
      ...row,
      balanceSnapUnits: safePostgresInteger(row.balanceSnapUnits, "postgres_admin_credit_non_user_balance_units_invalid"),
    }));
    return { items: normalizedItems, page, pageSize, total, totalPages };
  }

  async getAdminCreditDirectorySummary(): Promise<import("./queries/credits.js").CreditDirectorySummary> {
    const row = await this.one<import("./queries/credits.js").CreditDirectorySummary>(
      `SELECT
         COALESCE(SUM(CASE WHEN "scope_ref" LIKE 'user:%' THEN "balance_snap_units" ELSE 0 END), 0) AS "userBalanceUnits",
         COALESCE(SUM(CASE WHEN "scope_ref" LIKE 'user:%' THEN 1 ELSE 0 END), 0)::int AS "userAccountCount",
         COALESCE(SUM(CASE WHEN "scope_ref" LIKE 'user:%' AND "balance_snap_units" < 0 THEN 1 ELSE 0 END), 0)::int AS "negativeUserCount",
         COALESCE(SUM(CASE WHEN "scope_ref" NOT LIKE 'user:%' THEN "balance_snap_units" ELSE 0 END), 0) AS "nonUserBalanceUnits",
         COALESCE(SUM(CASE WHEN "scope_ref" NOT LIKE 'user:%' THEN 1 ELSE 0 END), 0)::int AS "nonUserAccountCount",
         (SELECT COUNT(*)::int FROM "credit_transfer_policies" WHERE "scope_ref" LIKE 'user:%' AND "transfer_out_enabled" = 0) AS "transferDisabledUserCount"
       FROM "credit_accounts"`,
      [],
    );
    if (!row) throw new Error("postgres_admin_credit_summary_empty");
    return {
      ...row,
      userBalanceUnits: safePostgresInteger(row.userBalanceUnits, "postgres_admin_credit_user_balance_summary_invalid"),
      nonUserBalanceUnits: safePostgresInteger(row.nonUserBalanceUnits, "postgres_admin_credit_non_user_balance_summary_invalid"),
    };
  }

  async getAdminCreditConfigurationSummary(): Promise<import("./queries/credits.js").CreditConfigurationSummary> {
    const row = await this.one<import("./queries/credits.js").CreditConfigurationSummary>(
      `SELECT (SELECT COUNT(*)::int FROM "credit_products") AS "productCount",
              (SELECT COUNT(*)::int FROM "payment_channels") AS "paymentChannelCount",
              (SELECT COUNT(*)::int FROM "payment_channels" WHERE "status" = 'draft') AS "draftPaymentChannelCount",
              (SELECT COUNT(*)::int FROM "credit_product_listings" WHERE "status" = 'enabled') AS "enabledListingCount"`,
      [],
    );
    if (!row) throw new Error("postgres_admin_credit_configuration_empty");
    return row;
  }

  async pageDraftPaymentChannels(page = 1, requestedPageSize?: number): Promise<import("./queries/pagination.js").PageResult<import("./queries/credits.js").DraftPaymentChannelRow>> {
    const input = requestedPageSize === undefined ? { page, status: "draft" } : { page, pageSize: requestedPageSize, status: "draft" };
    return this.pageSimpleTable("payment_channels", input, ["id", "code", "display_name"], `SELECT "id", "code", "display_name" AS "displayName", "payment_network" AS "paymentNetwork", "payment_asset" AS "paymentAsset", "settlement_mode" AS "settlementMode", "status"`, `ORDER BY "created_at" ASC, "id" ASC`) as Promise<import("./queries/pagination.js").PageResult<import("./queries/credits.js").DraftPaymentChannelRow>>;
  }

  async pageCardTransfers(
    referenceCode?: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageCardTransfers"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const normalizedReferenceCode = referenceCode?.trim().slice(0, 200) ?? "";
    const filter = `WHERE $1 = '' OR "reference_code" = $1`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "card_transfers" ${filter}`, [normalizedReferenceCode]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_card_transfer_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageCardTransfers"]>>["items"][number]>(
      `SELECT "id", "card_id" AS "cardId", "from_user_id" AS "fromUserId", "to_user_id" AS "toUserId",
              "reference_code" AS "referenceCode", "note", "created_at" AS "createdAt"
       FROM "card_transfers" ${filter}
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $2 OFFSET $3`,
      [normalizedReferenceCode, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageUserPlanCards(
    userId: string,
    planId: string,
    page = 1,
    at = nowIso(),
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserPlanCards"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "cards"
       WHERE "owner_user_id" = $1 AND "card_type" = 'plan' AND "plan_id" = $2`,
      [userId, planId],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_user_plan_card_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    type CardRow = Awaited<ReturnType<ApplicationOperationPort["pageUserPlanCards"]>>["items"][number];
    type RawCardRow = Omit<CardRow, "canUse" | "canSend"> & { canUse: number; canSend: number };
    const rows = await this.rows<RawCardRow>(
      `SELECT card."id", card."card_type" AS "cardType", card."issuance_type" AS "issuanceType",
              card."owner_user_id" AS "ownerUserId", card."plan_id" AS "planId", plan."name" AS "planName",
              plan."version" AS "planVersion", plan."plan_status" AS "planStatus",
              NULL AS "creditProductId", NULL AS "creditProductName", NULL AS "creditAmountUnits",
              card."created_at" AS "createdAt", card."used_at" AS "usedAt",
              card."invalidated_at" AS "invalidatedAt", card."invalidation_reason" AS "invalidationReason",
              card."expires_at" AS "expiresAt", card."replaces_card_id" AS "replacesCardId",
              CASE
                WHEN replacement."id" IS NOT NULL THEN 'replaced'
                WHEN card."invalidated_at" IS NOT NULL THEN 'invalidated'
                WHEN card."used_at" IS NOT NULL THEN 'used'
                WHEN card."expires_at" <= $3 THEN 'expired'
                ELSE 'available'
              END AS "status",
              replacement."id" AS "replacedByCardId",
              CASE WHEN replacement."id" IS NULL AND card."invalidated_at" IS NULL
                    AND card."used_at" IS NULL AND card."expires_at" > $3
                    AND plan."plan_status" IN ('enabled', 'closed') THEN 1 ELSE 0 END AS "canUse",
              CASE WHEN replacement."id" IS NULL AND card."invalidated_at" IS NULL
                    AND card."used_at" IS NULL AND card."expires_at" > $3
                    AND plan."plan_status" = 'enabled' THEN 1 ELSE 0 END AS "canSend",
              CASE
                WHEN replacement."id" IS NOT NULL THEN 'card_replaced'
                WHEN card."invalidated_at" IS NOT NULL THEN 'card_invalidated'
                WHEN card."used_at" IS NOT NULL THEN 'card_used'
                WHEN card."expires_at" <= $3 THEN 'card_expired'
                WHEN plan."plan_status" = 'disabled' THEN 'plan_disabled'
                ELSE NULL
              END AS "useReasonCode",
              CASE
                WHEN replacement."id" IS NOT NULL THEN 'card_replaced'
                WHEN card."invalidated_at" IS NOT NULL THEN 'card_invalidated'
                WHEN card."used_at" IS NOT NULL THEN 'card_used'
                WHEN card."expires_at" <= $3 THEN 'card_expired'
                WHEN plan."plan_status" = 'disabled' THEN 'plan_disabled'
                WHEN plan."plan_status" = 'closed' THEN 'plan_closed'
                ELSE NULL
              END AS "sendReasonCode"
       FROM "cards" card
       INNER JOIN "plans" plan ON plan."id" = card."plan_id"
       LEFT JOIN "cards" replacement ON replacement."replaces_card_id" = card."id"
       WHERE card."owner_user_id" = $1 AND card."card_type" = 'plan' AND card."plan_id" = $2
       ORDER BY card."created_at" DESC, card."id" DESC
       LIMIT $4 OFFSET $5`,
      [userId, planId, at, pageSize, (normalizedPage - 1) * pageSize],
    );
    const items = rows.map((row) => ({ ...row, canUse: row.canUse === 1, canSend: row.canSend === 1 }));
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageUserCardInventory(
    userId: string,
    page = 1,
    at = nowIso(),
    requestedPageSize?: number,
    inventoryStatus: UserCardInventoryStatusFilter = "available",
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserCardInventory"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const inventoryCte = `WITH owned_cards AS (
         SELECT card."id", card."card_type" AS "cardType", card."issuance_type" AS "issuanceType",
                card."owner_user_id" AS "ownerUserId", card."plan_id" AS "planId",
                card."credit_product_id" AS "creditProductId", card."credit_amount_units" AS "creditAmountUnits",
                card."created_at" AS "createdAt", card."used_at" AS "usedAt",
                card."invalidated_at" AS "invalidatedAt", card."invalidation_reason" AS "invalidationReason",
                card."expires_at" AS "expiresAt", card."replaces_card_id" AS "replacesCardId",
                replacement."id" AS "replacedByCardId",
                CASE
                  WHEN replacement."id" IS NOT NULL THEN 'replaced'
                  WHEN card."invalidated_at" IS NOT NULL THEN 'invalidated'
                  WHEN card."used_at" IS NOT NULL THEN 'used'
                  WHEN card."expires_at" <= $2 THEN 'expired'
                  ELSE 'available'
                END AS "cardStatus"
         FROM "cards" card
         LEFT JOIN "cards" replacement ON replacement."replaces_card_id" = card."id"
         WHERE card."owner_user_id" = $1
       ), inventory AS (
         SELECT 'plan' AS "kind", plan."id" AS "stableKey", MAX(owned."createdAt") AS "latestCreatedAt",
                plan."id" AS "planId", plan."name" AS "planName", plan."version" AS "planVersion",
                plan."plan_status" AS "planStatus", COUNT(*)::int AS "totalCount",
                SUM(CASE WHEN owned."cardStatus" = 'available' THEN 1 ELSE 0 END)::int AS "availableCount",
                SUM(CASE WHEN owned."cardStatus" = 'replaced' THEN 1 ELSE 0 END)::int AS "replacedCount",
                SUM(CASE WHEN owned."cardStatus" = 'invalidated' THEN 1 ELSE 0 END)::int AS "invalidatedCount",
                SUM(CASE WHEN owned."cardStatus" = 'used' THEN 1 ELSE 0 END)::int AS "usedCount",
                SUM(CASE WHEN owned."cardStatus" = 'expired' THEN 1 ELSE 0 END)::int AS "expiredCount",
                MIN(CASE WHEN owned."cardStatus" = 'available' THEN owned."expiresAt" END) AS "nearestAvailableExpiresAt",
                NULL AS "id", NULL AS "issuanceType", NULL AS "ownerUserId", NULL AS "creditProductId",
                NULL AS "creditProductName", NULL AS "creditAmountUnits", NULL AS "createdAt", NULL AS "usedAt",
                NULL AS "invalidatedAt", NULL AS "invalidationReason", NULL AS "expiresAt", NULL AS "replacesCardId",
                NULL AS "cardStatus", NULL AS "replacedByCardId"
         FROM owned_cards owned
         INNER JOIN "plans" plan ON plan."id" = owned."planId"
         WHERE owned."cardType" = 'plan'
         GROUP BY plan."id", plan."name", plan."version", plan."plan_status"
         UNION ALL
         SELECT 'credit', owned."id", owned."createdAt", NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, owned."id", owned."issuanceType", owned."ownerUserId", owned."creditProductId",
                product."display_name", owned."creditAmountUnits", owned."createdAt", owned."usedAt",
                owned."invalidatedAt", owned."invalidationReason", owned."expiresAt", owned."replacesCardId",
                owned."cardStatus", owned."replacedByCardId"
         FROM owned_cards owned
         INNER JOIN "credit_products" product ON product."id" = owned."creditProductId"
         WHERE owned."cardType" = 'credit'
       )`;
    const inventoryFilter = `WHERE $3 = 'all'
         OR ("kind" = 'plan' AND "planStatus" IN ('enabled', 'closed') AND "availableCount" > 0)
         OR ("kind" = 'credit' AND "cardStatus" = 'available')`;
    const totalRow = await this.one<{ count: number }>(
      `${inventoryCte}
       SELECT COUNT(*)::int AS "count"
       FROM inventory
       ${inventoryFilter}`,
      [userId, at, inventoryStatus],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_user_card_inventory_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    type InventoryItem = Awaited<ReturnType<ApplicationOperationPort["pageUserCardInventory"]>>["items"][number];
    type RawInventoryRow = {
      kind: "plan" | "credit";
      stableKey: string;
      latestCreatedAt: string;
      planId: string | null;
      planName: string | null;
      planVersion: number | null;
      planStatus: string | null;
      totalCount: number | null;
      availableCount: number | null;
      replacedCount: number | null;
      invalidatedCount: number | null;
      usedCount: number | null;
      expiredCount: number | null;
      nearestAvailableExpiresAt: string | null;
      id: string | null;
      issuanceType: string | null;
      ownerUserId: string | null;
      creditProductId: string | null;
      creditProductName: string | null;
      creditAmountUnits: number | null;
      createdAt: string | null;
      usedAt: string | null;
      invalidatedAt: string | null;
      invalidationReason: string | null;
      expiresAt: string | null;
      replacesCardId: string | null;
      cardStatus: string | null;
      replacedByCardId: string | null;
    };
    const rows = await this.rows<RawInventoryRow>(
      `${inventoryCte}
       SELECT * FROM inventory
       ${inventoryFilter}
       ORDER BY "latestCreatedAt" DESC, "stableKey" DESC
       LIMIT $4 OFFSET $5`,
      [userId, at, inventoryStatus, pageSize, (normalizedPage - 1) * pageSize],
    );
    const items = rows.map((row): InventoryItem => {
      if (row.kind === "plan") {
        return {
          kind: "plan",
          planId: row.planId!,
          planName: row.planName!,
          planVersion: row.planVersion!,
          planStatus: row.planStatus! as "enabled" | "disabled" | "closed",
          totalCount: row.totalCount!,
          availableCount: row.availableCount!,
          replacedCount: row.replacedCount!,
          invalidatedCount: row.invalidatedCount!,
          usedCount: row.usedCount!,
          expiredCount: row.expiredCount!,
          nearestAvailableExpiresAt: row.nearestAvailableExpiresAt,
          latestCreatedAt: row.latestCreatedAt,
        };
      }
      const status = row.cardStatus! as "available" | "replaced" | "invalidated" | "used" | "expired";
      const available = status === "available";
      return {
        kind: "credit",
        card: {
          id: row.id!, cardType: "credit", issuanceType: row.issuanceType! as CardIssuanceType, ownerUserId: row.ownerUserId!,
          planId: null, planName: null, planVersion: null, planStatus: null,
          creditProductId: row.creditProductId!, creditProductName: row.creditProductName!, creditAmountUnits: row.creditAmountUnits!,
          createdAt: row.createdAt!, usedAt: row.usedAt, invalidatedAt: row.invalidatedAt,
          invalidationReason: row.invalidationReason, expiresAt: row.expiresAt!, replacesCardId: row.replacesCardId,
          status, replacedByCardId: row.replacedByCardId, canUse: available, canSend: available,
          useReasonCode: available ? null : postgresCardStatusReasonCode(status),
          sendReasonCode: available ? null : postgresCardStatusReasonCode(status),
        },
      };
    });
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageUserCardTransfers(
    userId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserCardTransfers"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const filter = `WHERE "from_user_id" = $1 OR "to_user_id" = $1`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "card_transfers" ${filter}`, [userId]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_user_card_transfer_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageUserCardTransfers"]>>["items"][number]>(
      `SELECT "id", "card_id" AS "cardId", "from_user_id" AS "fromUserId", "to_user_id" AS "toUserId",
              "reference_code" AS "referenceCode", "note", "created_at" AS "createdAt"
       FROM "card_transfers" ${filter}
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $2 OFFSET $3`,
      [userId, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageCreditProducts(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageCreditProducts"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_products"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_credit_product_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageCreditProducts"]>>["items"][number]>(
      `SELECT "id", "code", "display_name" AS "displayName", "description", "admin_note" AS "adminNote",
              "credited_amount_units" AS "creditedAmountUnits", "status", "display_order" AS "displayOrder",
              "created_at" AS "createdAt"
       FROM "credit_products"
       ORDER BY "display_order" ASC, "created_at" ASC, "id" ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pagePaymentChannels(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePaymentChannels"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "payment_channels"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_payment_channel_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pagePaymentChannels"]>>["items"][number]>(
      `SELECT channel."id", channel."code", channel."display_name" AS "displayName",
              channel."payment_network" AS "paymentNetwork", channel."payment_asset" AS "paymentAsset",
              channel."settlement_mode" AS "settlementMode",
              channel."recipient_identifier_type" AS "recipientIdentifierType",
              channel."transaction_reference_type" AS "transactionReferenceType",
              channel."recipient_identifier" AS "recipientIdentifier",
              channel."recipient_identifier_display" AS "recipientIdentifierDisplay",
              channel."normalized_recipient_identifier_hash" AS "normalizedRecipientIdentifierHash",
              channel."payment_instruction" AS "paymentInstruction", channel."status",
              channel."created_by_user_id" AS "createdByUserId", channel."created_at" AS "createdAt",
              (SELECT COUNT(*)::int FROM "payment_channel_instruction_attachments" attachment
               WHERE attachment."payment_channel_id" = channel."id") AS "instructionAttachmentCount"
       FROM "payment_channels" channel
       ORDER BY channel."created_at" ASC, channel."id" ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageCreditProductListings(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageCreditProductListings"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_product_listings"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_credit_listing_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageCreditProductListings"]>>["items"][number]>(
      `SELECT "id", "product_id" AS "productId", "payment_channel_id" AS "paymentChannelId",
              "price_amount_units" AS "priceAmountUnits", "status", "created_at" AS "createdAt"
       FROM "credit_product_listings"
       ORDER BY "created_at" ASC, "id" ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageCreditTransferPolicies(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageCreditTransferPolicies"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_transfer_policies"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_credit_transfer_policy_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageCreditTransferPolicies"]>>["items"][number]>(
      `SELECT "id", "scope_ref" AS "scopeRef", "transfer_out_enabled" AS "transferOutEnabled",
              "updated_by" AS "updatedBy", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "credit_transfer_policies"
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async searchCreditProductCandidates(
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchCreditProductCandidates"]>>> {
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const pageSize = 20;
    const filter = `WHERE "status" = 'enabled'
      AND ($1 = '' OR strpos(lower("id"), $1) > 0 OR strpos(lower("code"), $1) > 0 OR strpos(lower("display_name"), $1) > 0)`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "credit_products" ${filter}`, [normalized]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_credit_product_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchCreditProductCandidates"]>>["items"][number]>(
      `SELECT "id", "code", "display_name" AS "displayName", "credited_amount_units" AS "creditedAmountUnits", "status"
       FROM "credit_products" ${filter}
       ORDER BY "display_order" ASC, "created_at" ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async searchPaymentChannelCandidates(
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchPaymentChannelCandidates"]>>> {
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const pageSize = 20;
    const filter = `WHERE "status" = 'enabled'
      AND ($1 = '' OR strpos(lower("id"), $1) > 0 OR strpos(lower("code"), $1) > 0
        OR strpos(lower("display_name"), $1) > 0 OR strpos(lower("payment_network"), $1) > 0
        OR strpos(lower("payment_asset"), $1) > 0)`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "payment_channels" ${filter}`, [normalized]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_payment_channel_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchPaymentChannelCandidates"]>>["items"][number]>(
      `SELECT "id", "code", "display_name" AS "displayName", "payment_network" AS "paymentNetwork",
              "payment_asset" AS "paymentAsset", "status"
       FROM "payment_channels" ${filter}
       ORDER BY "created_at" ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async cursorUserTopups(
    userId: string,
    cursor?: string,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["cursorUserTopups"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const boundary = decodePostgresCreditCursor(cursor, "topup");
    const rows = await this.rows<Awaited<ReturnType<ApplicationOperationPort["cursorUserTopups"]>>["items"][number]>(
      `SELECT topup."id", topup."status", topup."credited_amount_units" AS "creditedAmountUnits",
              topup."expected_payment_amount_units" AS "expectedPaymentAmountUnits",
              topup."payment_asset" AS "paymentAsset", topup."payment_network" AS "paymentNetwork",
              topup."transaction_reference_tail" AS "transactionReferenceTail", topup."expires_at" AS "expiresAt",
              (SELECT COUNT(*)::int FROM "credit_topup_attachments" attachment
               WHERE attachment."topup_id" = topup."id"
                 AND attachment."uploaded_by_user_id" = $1
                 AND attachment."attachment_purpose" = 'payment_evidence') AS "attachmentCount",
              topup."created_at" AS "createdAt"
       FROM "credit_topups" topup
       WHERE topup."user_id" = $1
         AND ($2 = '' OR topup."created_at" < $2
           OR (topup."created_at" = $2 AND topup."id" < $3))
       ORDER BY topup."created_at" DESC, topup."id" DESC
       LIMIT $4`,
      [userId, boundary?.createdAt ?? "", boundary?.id ?? "", pageSize + 1],
    );
    return postgresCreditCursorPage(rows, "topup", pageSize);
  }

  async cursorAdminTopups(
    cursor?: string,
    userId?: string,
    status?: string,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["cursorAdminTopups"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const boundary = decodePostgresCreditCursor(cursor, "topup");
    const rows = await this.rows<Awaited<ReturnType<ApplicationOperationPort["cursorAdminTopups"]>>["items"][number]>(
      `SELECT topup."id", topup."user_id" AS "userId", identity."email" AS "userEmail", topup."status",
              topup."settlement_mode" AS "settlementMode", topup."card_id" AS "cardId",
              topup."credited_amount_units" AS "creditedAmountUnits",
              topup."expected_payment_amount_units" AS "expectedPaymentAmountUnits",
              topup."confirmed_received_amount_units" AS "confirmedReceivedAmountUnits",
              topup."payment_asset" AS "paymentAsset", topup."payment_network" AS "paymentNetwork",
              topup."transaction_reference" AS "transactionReference",
              topup."transaction_reference_tail" AS "transactionReferenceTail",
              topup."reviewed_by_user_id" AS "reviewedByUserId", topup."refund_recorded_at" AS "refundRecordedAt",
              (SELECT COUNT(*)::int FROM "credit_topup_attachments" attachment WHERE attachment."topup_id" = topup."id") AS "attachmentCount",
              EXISTS (
                SELECT 1 FROM "credit_topup_attachments" attachment
                WHERE attachment."topup_id" = topup."id" AND attachment."attachment_purpose" = 'payment_evidence'
                  AND EXISTS (
                    SELECT 1 FROM "credit_topup_attachments" duplicate
                    WHERE duplicate."sha256" = attachment."sha256"
                      AND duplicate."attachment_purpose" = 'payment_evidence'
                      AND duplicate."id" <> attachment."id"
                  )
              ) AS "duplicateEvidence",
              topup."created_at" AS "createdAt"
       FROM "credit_topups" topup
       INNER JOIN "user_controls" user_row ON user_row."id" = topup."user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       WHERE ($1 = '' OR topup."user_id" = $1)
         AND ($2 = '' OR topup."status" = $2)
         AND ($3 = '' OR topup."created_at" < $3 OR (topup."created_at" = $3 AND topup."id" < $4))
       ORDER BY topup."created_at" DESC, topup."id" DESC
       LIMIT $5`,
      [userId ?? "", status ?? "", boundary?.createdAt ?? "", boundary?.id ?? "", pageSize + 1],
    );
    return postgresCreditCursorPage(rows, "topup", pageSize);
  }

  async cursorCreditLedger(
    accountId: string,
    cursor?: string,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["cursorCreditLedger"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const boundary = decodePostgresCreditCursor(cursor, "ledger");
    const rows = await this.rows<Awaited<ReturnType<ApplicationOperationPort["cursorCreditLedger"]>>["items"][number]>(
      `SELECT "id", "account_id" AS "accountId", "event_type" AS "eventType", "amount_units" AS "amountUnits",
              "transfer_id" AS "transferId", "related_event_id" AS "relatedEventId",
              "plan_subscription_id" AS "planSubscriptionId", "billing_event_id" AS "billingEventId",
              "related_topup_id" AS "relatedTopupId", "card_id" AS "cardId",
              "from_account_id" AS "fromAccountId", "to_account_id" AS "toAccountId",
              "reason", "actor_user_id" AS "actorUserId", "created_at" AS "createdAt"
       FROM "credit_ledger_events"
       WHERE "account_id" = $1
         AND ($2 = '' OR "created_at" < $2
           OR ("created_at" = $2 AND "id" < $3))
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $4`,
      [accountId, boundary?.createdAt ?? "", boundary?.id ?? "", pageSize + 1],
    );
    return postgresCreditCursorPage(rows, "ledger", pageSize);
  }

  async expireCreditTopups(now = nowIso(), userId?: string): Promise<Awaited<ReturnType<ApplicationOperationPort["expireCreditTopups"]>>> {
    const values: unknown[] = [now];
    const userFilter = userId === undefined ? "" : ` AND "user_id" = $${values.push(userId)}`;
    const result = await this.query(
      `UPDATE "credit_topups"
       SET "status" = 'expired', "expired_at" = $1, "updated_at" = $1
       WHERE "status" = 'pending_payment' AND "settlement_mode" = 'manual_review' AND "expires_at" <= $1${userFilter}`,
      values,
    );
    return result.rowCount ?? 0;
  }

  async searchActiveTeamSubscriptionCandidates(
    input: Parameters<ApplicationOperationPort["searchActiveTeamSubscriptionCandidates"]>[0],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchActiveTeamSubscriptionCandidates"]>>> {
    const query = input.query.trim().toLowerCase().slice(0, 100);
    const search = query ? `%${query}%` : "";
    const scopeRef = `team:${input.teamId}`;
    const from = `
      FROM "plan_subscriptions" subscription
      INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
      WHERE subscription."scope_ref" = $2
        AND subscription."subscription_lifecycle" = 'active'
        AND subscription."effective_start" <= $3
        AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $3)
        AND plan."plan_status" IN ('enabled', 'closed')
        AND ($1 = '' OR lower(plan."name") LIKE $1 OR lower(subscription."id") LIKE $1 OR lower(plan."billing_mode") LIKE $1)`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" ${from}`, [search, scopeRef, input.calculatedAt]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_team_subscription_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchActiveTeamSubscriptionCandidates"]>>["items"][number]>(
      `SELECT subscription."id", plan."name" AS "planName", plan."version" AS "planVersion",
              plan."billing_mode" AS "billingMode", subscription."effective_start" AS "effectiveStart",
              subscription."effective_end" AS "effectiveEnd"
       ${from}
       ORDER BY subscription."priority" ASC, subscription."effective_start" ASC,
                subscription."created_at" ASC, subscription."id" ASC
       LIMIT 20 OFFSET $4`,
      [search, scopeRef, input.calculatedAt, (page - 1) * 20],
    );
    return { items, page, pageSize: 20, total, totalPages };
  }

  async pageTeamMemberUsage(
    input: Parameters<ApplicationOperationPort["pageTeamMemberUsage"]>[0],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageTeamMemberUsage"]>>> {
    const subscription = await this.one<{
      id: string;
      planName: string;
      planVersion: number;
      billingMode: string;
      effectiveStart: string;
      effectiveEnd: string | null;
    }>(
      `SELECT subscription."id", plan."name" AS "planName", plan."version" AS "planVersion",
              plan."billing_mode" AS "billingMode", subscription."effective_start" AS "effectiveStart",
              subscription."effective_end" AS "effectiveEnd"
       FROM "plan_subscriptions" subscription
       INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."id" = $1
         AND subscription."scope_ref" = $2
         AND subscription."subscription_lifecycle" = 'active'
         AND subscription."effective_start" <= $3
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $3)
         AND plan."plan_status" IN ('enabled', 'closed')`,
      [input.subscriptionId, `team:${input.teamId}`, input.calculatedAt],
    );
    if (!subscription) throw new RelayError("plan_source_unavailable", "Plan source unavailable", 404);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const periodStart = subscription.effectiveStart;
    const periodEnd = subscription.effectiveEnd && subscription.effectiveEnd < input.calculatedAt
      ? subscription.effectiveEnd
      : input.calculatedAt;
    const query = input.query.trim().toLowerCase().slice(0, 100);
    const search = query ? `%${query}%` : "";
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "team_memberships" membership
       INNER JOIN "user_controls" user_row ON user_row."id" = membership."user_id"
       INNER JOIN "user" identity ON identity."id" = user_row."id"
       WHERE membership."team_id" = $1
         AND ($2 = '' OR lower(identity."email") LIKE $2 OR lower(membership."user_id") LIKE $2)`,
      [input.teamId, search],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_team_member_usage_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const summaryRow = await this.one<{
      requestCount: number;
      totalTokens: number;
      billableAmount: number;
      currentMemberRequestCount: number;
      currentMemberTokens: number;
      currentMemberBillableAmount: number;
      historicalRequestCount: number;
      historicalTokens: number;
      historicalBillableAmount: number;
    }>(
      postgresTeamUsageCtes() + `
       SELECT COALESCE(SUM(usage."requestCount"), 0)::int AS "requestCount",
              COALESCE(SUM(usage."totalTokens"), 0) AS "totalTokens",
              COALESCE(SUM(usage."billableAmount"), 0) AS "billableAmount",
              COALESCE(SUM(CASE WHEN member."userId" IS NOT NULL THEN usage."requestCount" ELSE 0 END), 0)::int AS "currentMemberRequestCount",
              COALESCE(SUM(CASE WHEN member."userId" IS NOT NULL THEN usage."totalTokens" ELSE 0 END), 0) AS "currentMemberTokens",
              COALESCE(SUM(CASE WHEN member."userId" IS NOT NULL THEN usage."billableAmount" ELSE 0 END), 0) AS "currentMemberBillableAmount",
              COALESCE(SUM(CASE WHEN member."userId" IS NULL THEN usage."requestCount" ELSE 0 END), 0)::int AS "historicalRequestCount",
              COALESCE(SUM(CASE WHEN member."userId" IS NULL THEN usage."totalTokens" ELSE 0 END), 0) AS "historicalTokens",
              COALESCE(SUM(CASE WHEN member."userId" IS NULL THEN usage."billableAmount" ELSE 0 END), 0) AS "historicalBillableAmount"
       FROM usage_by_user usage
       LEFT JOIN current_members member ON member."userId" = usage."userId"`,
      [input.subscriptionId, periodStart, periodEnd, input.teamId],
    );
    const order = postgresTeamMemberUsageOrder(input.sort, input.direction);
    const rows = await this.rows<{
      userId: string;
      email: string;
      rolesJson: string;
      status: string;
      requestCount: number;
      totalTokens: number;
      billableAmount: number;
      lastUsedAt: string | null;
    }>(
      postgresTeamUsageCtes() + `
       SELECT member."userId", member."email", member."rolesJson", member."status",
              COALESCE(usage."requestCount", 0)::int AS "requestCount",
              COALESCE(usage."totalTokens", 0) AS "totalTokens",
              COALESCE(usage."billableAmount", 0) AS "billableAmount",
              usage."lastUsedAt"
       FROM current_members member
       LEFT JOIN usage_by_user usage ON usage."userId" = member."userId"
       WHERE ($5 = '' OR lower(member."email") LIKE $5 OR lower(member."userId") LIKE $5)
       ORDER BY ${order}
       LIMIT $6 OFFSET $7`,
      [input.subscriptionId, periodStart, periodEnd, input.teamId, search, pageSize, (page - 1) * pageSize],
    );
    return {
      subscription: {
        id: subscription.id,
        planName: subscription.planName,
        planVersion: subscription.planVersion,
        billingMode: postgresPlanBillingMode(subscription.billingMode),
        effectiveStart: subscription.effectiveStart,
        effectiveEnd: subscription.effectiveEnd,
      },
      periodStart,
      periodEnd,
      calculatedAt: input.calculatedAt,
      summary: {
        requestCount: Number(summaryRow?.requestCount ?? 0),
        totalTokens: Number(summaryRow?.totalTokens ?? 0),
        billableAmount: Number(summaryRow?.billableAmount ?? 0),
        currentMemberRequestCount: Number(summaryRow?.currentMemberRequestCount ?? 0),
        currentMemberTokens: Number(summaryRow?.currentMemberTokens ?? 0),
        currentMemberBillableAmount: Number(summaryRow?.currentMemberBillableAmount ?? 0),
        historicalRequestCount: Number(summaryRow?.historicalRequestCount ?? 0),
        historicalTokens: Number(summaryRow?.historicalTokens ?? 0),
        historicalBillableAmount: Number(summaryRow?.historicalBillableAmount ?? 0),
      },
      items: rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        roles: postgresSafeRoles(row.rolesJson),
        status: row.status,
        requestCount: Number(row.requestCount),
        totalTokens: Number(row.totalTokens),
        billableAmount: Number(row.billableAmount),
        lastUsedAt: row.lastUsedAt,
      })),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  async listActivePlanSubscriptionsForScopeRefs(
    scopeRefs: ScopeRef[],
    at = nowIso(),
    restriction?: ApiKeyPlanSourceRestrictionDecision,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["listActivePlanSubscriptionsForScopeRefs"]>>> {
    const uniqueScopes = [...new Set(scopeRefs)];
    if (uniqueScopes.length === 0) return [];
    const scopePlaceholders = uniqueScopes.map((_, index) => `$${index + 1}`).join(", ");
    const atParameter = uniqueScopes.length + 1;
    const restrictionPredicate = planSourceRestrictionPredicate(restriction, 'subscription."plan_id"', 'subscription."scope_ref"', atParameter + 1);
    const subscriptions = await this.rows<PlanSubscription>(
      `SELECT subscription.*
       FROM "plan_subscriptions" subscription
       INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."scope_ref" IN (${scopePlaceholders})
         AND subscription."subscription_lifecycle" = 'active'
         AND subscription."effective_start" <= $${atParameter}
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $${atParameter})
         AND ${restrictionPredicate.sql}
         AND plan."plan_status" IN ('enabled', 'closed')`,
      [...uniqueScopes, at, ...restrictionPredicate.params],
    );
    const planIds = [...new Set(subscriptions.map((subscription) => subscription.planId))];
    if (planIds.length === 0) return [];
    const planPlaceholders = planIds.map((_, index) => `$${index + 1}`).join(", ");
    const plans = await this.rows<PlanDefinition>(
      `SELECT * FROM "plans" WHERE "id" IN (${planPlaceholders})`,
      planIds,
    );
    const plansById = new Map(plans.map((plan) => [plan.id, plan]));
    const limitsByPlan = await this.listPlanBudgetLimitsForPlans(planIds);
    const scopeOrder = new Map(uniqueScopes.map((scopeRef, index) => [scopeRef, index]));
    subscriptions.sort((left, right) =>
      (scopeOrder.get(left.scopeRef as ScopeRef) ?? Number.MAX_SAFE_INTEGER) - (scopeOrder.get(right.scopeRef as ScopeRef) ?? Number.MAX_SAFE_INTEGER)
      || left.priority - right.priority
      || left.effectiveStart.localeCompare(right.effectiveStart)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
    return subscriptions.flatMap((subscription) => {
      const plan = plansById.get(subscription.planId);
      return plan ? [{ scopeRef: subscription.scopeRef as ScopeRef, subscription, plan, budgetLimits: limitsByPlan.get(plan.id) ?? [] }] : [];
    });
  }

  async listPlanBudgetUsageSourcesForUser(userId: string, at = nowIso(), restriction?: ApiKeyPlanSourceRestrictionDecision): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanBudgetUsageSourcesForUser"]>>> {
    const scopeRefs = await this.listEffectiveSubscriptionScopesForUser(userId);
    const candidates = await this.listActivePlanSubscriptionsForScopeRefs(scopeRefs, at, restriction);
    if (candidates.length === 0) return [];
    const planIds = [...new Set(candidates.map((candidate) => candidate.plan.id))];
    const modelRows = await this.rows<{ planId: string; exposedModel: string }>(
      `SELECT relation."plan_id" AS "planId", access_point."exposed_model" AS "exposedModel"
       FROM "plan_access_points" relation
       INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
       WHERE relation."plan_id" = ANY($1::text[]) AND access_point."status" = 'enabled'
       ORDER BY relation."plan_id" ASC, access_point."exposed_model" ASC`,
      [planIds],
    );
    const modelsByPlan = new Map<string, string[]>();
    for (const row of modelRows) {
      const models = modelsByPlan.get(row.planId) ?? [];
      if (models.at(-1) !== row.exposedModel) models.push(row.exposedModel);
      modelsByPlan.set(row.planId, models);
    }
    const scopeOrder = new Map(scopeRefs.map((scopeRef, index) => [scopeRef, index]));
    const ordered = [...candidates].sort((left, right) =>
      (scopeOrder.get(left.scopeRef) ?? Number.MAX_SAFE_INTEGER) - (scopeOrder.get(right.scopeRef) ?? Number.MAX_SAFE_INTEGER)
      || left.subscription.priority - right.subscription.priority
      || left.plan.name.localeCompare(right.plan.name)
      || left.plan.version - right.plan.version
      || left.subscription.effectiveStart.localeCompare(right.subscription.effectiveStart)
      || left.subscription.id.localeCompare(right.subscription.id));
    const result: Awaited<ReturnType<ApplicationOperationPort["listPlanBudgetUsageSourcesForUser"]>> = [];
    for (const candidate of ordered) {
      const windows = candidate.budgetLimits.map((limit, index) => ({ limit, input: planBudgetWindow(limit, candidate.subscription, at), key: `${candidate.subscription.id}:${index}` }));
      const starts = windows.map(({ input }) => input.start);
      const events = starts.length === 0 ? [] : await this.rows<{ userId: string; createdAt: string; totalTokens: number; billableAmount: number }>(
        `${POSTGRES_REQUEST_IDENTITY_CTE} SELECT request_log."user_id" AS "userId", billing_event."occurred_at" AS "createdAt",
                billing_event."total_tokens" AS "totalTokens", billing_event."billable_amount" AS "billableAmount"
         FROM "billing_history_refs" billing_event
         INNER JOIN request_identity request_log ON request_log."request_id" = billing_event."request_id"
         WHERE billing_event."billing_subscription_id" = $1
           AND billing_event."occurred_at" >= $2 AND billing_event."occurred_at" <= $3
         ORDER BY billing_event."occurred_at" ASC, billing_event."billing_event_id" ASC`,
        [candidate.subscription.id, starts.reduce((min, value) => value < min ? value : min), at],
      );
      result.push({
        scopeRef: candidate.scopeRef,
        subscription: candidate.subscription,
        plan: candidate.plan,
        budgetLimits: candidate.budgetLimits,
        applicableModels: modelsByPlan.get(candidate.plan.id) ?? [],
        limits: windows.map(({ limit, input }) => {
          const matching = events.filter((event) => event.createdAt >= input.start && event.createdAt <= input.end
            && (limit.limitScope === "subscription" || event.userId === userId));
          return {
            limit,
            periodStart: input.start,
            periodEnd: input.periodEnd,
            nextResetAt: input.nextResetAt,
            usedTokens: matching.reduce((sum, row) => sum + Number(row.totalTokens), 0),
            usedAmount: matching.reduce((sum, row) => sum + Number(row.billableAmount), 0),
          };
        }),
      });
    }
    return result;
  }

  async summarizeScopeBudgetUsageWindows(scopeRef: ScopeRef | readonly ScopeRef[], windows: Parameters<ApplicationOperationPort["summarizeScopeBudgetUsageWindows"]>[1]): Promise<Awaited<ReturnType<ApplicationOperationPort["summarizeScopeBudgetUsageWindows"]>>> {
    if (windows.length === 0) return [];
    if (Array.isArray(scopeRef)) {
      const scopeRefs = [...new Set(scopeRef)];
      const allowedScopeRefs = new Set(scopeRefs);
      const batchWindows = windows.map((window) => {
        if (!window.scopeRef || !allowedScopeRefs.has(window.scopeRef)) {
          throw new RelayError("invalid_scope_ref", "Budget usage window scope does not match the requested scope batch", 400);
        }
        return {
          key: window.key,
          scopeRef: window.scopeRef,
          start: window.start,
          end: window.end,
        };
      });
      const start = batchWindows.map((window) => window.start).reduce((min, value) => value < min ? value : min);
      const end = batchWindows.map((window) => window.end).reduce((max, value) => value > max ? value : max);
      const rows = await this.rows<{ key: string; usedTokens: number; usedAmount: number }>(
        `WITH request_identity AS (${POSTGRES_REQUEST_IDENTITY_SOURCE}), budget_windows AS (
           SELECT window_row."key", window_row."scopeRef", window_row."start", window_row."end"
           FROM jsonb_to_recordset($1::jsonb)
             AS window_row("key" text, "scopeRef" text, "start" text, "end" text)
         )
         SELECT bw."key",
                COALESCE(SUM(CASE WHEN (
                  bw."scopeRef" = 'global:'
                  OR (bw."scopeRef" LIKE 'team:%' AND request_log."team_id" = substring(bw."scopeRef" from 6))
                  OR (bw."scopeRef" LIKE 'user:%' AND request_log."user_id" = substring(bw."scopeRef" from 6))
                  OR (bw."scopeRef" LIKE 'key:%' AND request_log."api_key_id" = substring(bw."scopeRef" from 5))
                ) THEN billing_event."total_tokens" ELSE 0 END), 0)::double precision AS "usedTokens",
                COALESCE(SUM(CASE WHEN (
                  bw."scopeRef" = 'global:'
                  OR (bw."scopeRef" LIKE 'team:%' AND request_log."team_id" = substring(bw."scopeRef" from 6))
                  OR (bw."scopeRef" LIKE 'user:%' AND request_log."user_id" = substring(bw."scopeRef" from 6))
                  OR (bw."scopeRef" LIKE 'key:%' AND request_log."api_key_id" = substring(bw."scopeRef" from 5))
                ) THEN billing_event."billable_amount" ELSE 0 END), 0)::double precision AS "usedAmount"
         FROM budget_windows bw
         LEFT JOIN "billing_history_refs" billing_event
           ON billing_event."occurred_at" >= bw."start"
          AND billing_event."occurred_at" <= bw."end"
          AND billing_event."occurred_at" >= $2
          AND billing_event."occurred_at" <= $3
         LEFT JOIN request_identity request_log ON request_log."request_id" = billing_event."request_id"
         GROUP BY bw."key"
         ORDER BY bw."key" ASC`,
        [JSON.stringify(batchWindows), start, end],
      );
      const usageByKey = new Map(rows.map((row) => [row.key, row]));
      return windows.map((window) => {
        const usage = usageByKey.get(window.key);
        return {
          key: window.key,
          usedTokens: Number(usage?.usedTokens ?? 0),
          usedAmount: Number(usage?.usedAmount ?? 0),
          recovery: { nextRecoveryAt: null, nextRecoveryValue: null, fullRecoveryAt: null },
        };
      });
    }
    const [scopeType, scopeId] = (scopeRef as ScopeRef).split(":", 2);
    if (!scopeType || !scopeId || !["global", "team", "user", "key"].includes(scopeType)) throw new RelayError("invalid_scope_ref", "Invalid budget scope", 400);
    const start = windows.map((window) => window.start).reduce((min, value) => value < min ? value : min);
    const end = windows.map((window) => window.end).reduce((max, value) => value > max ? value : max);
    const scopeClause = scopeType === "team" ? `request_log."team_id" = $3` : scopeType === "user" ? `request_log."user_id" = $3` : scopeType === "key" ? `request_log."api_key_id" = $3` : "TRUE";
    const values = scopeType === "global" ? [start, end] : [start, end, scopeId];
    const events = await this.rows<{ createdAt: string; totalTokens: number; billableAmount: number }>(
      `${POSTGRES_REQUEST_IDENTITY_CTE} SELECT billing_event."occurred_at" AS "createdAt", billing_event."total_tokens" AS "totalTokens", billing_event."billable_amount" AS "billableAmount"
       FROM "billing_history_refs" billing_event
       INNER JOIN request_identity request_log ON request_log."request_id" = billing_event."request_id"
       WHERE ${scopeClause} AND billing_event."occurred_at" >= $1 AND billing_event."occurred_at" <= $2
       ORDER BY billing_event."occurred_at" ASC, billing_event."billing_event_id" ASC`,
      values,
    );
    return windows.map((window) => {
      const matching = events.filter((event) => event.createdAt >= window.start && event.createdAt <= window.end);
      return {
        ...window,
        usedTokens: matching.reduce((sum, row) => sum + Number(row.totalTokens), 0),
        usedAmount: matching.reduce((sum, row) => sum + Number(row.billableAmount), 0),
        recovery: { nextRecoveryAt: null, nextRecoveryValue: null, fullRecoveryAt: null },
      };
    });
  }

  async createTeamInviteLink(input: {
    teamId: string;
    createdByUserId: string;
    maxUses: number | null;
    activeLimitExempt?: boolean;
    id?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<TeamInviteLink> {
    const now = nowIso();
    return this.insertRow<TeamInviteLink>("team_invite_links", {
      id: input.id ?? createId("til"),
      teamId: input.teamId,
      createdByUserId: input.createdByUserId,
      maxUses: input.maxUses,
      usedCount: 0,
      activeLimitExempt: input.activeLimitExempt ? 1 : 0,
      status: input.status ?? "enabled",
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    });
  }

  async getOrCreateActiveTeamInviteLink(teamId: string, createdByUserId: string, maxUses: number | null): Promise<TeamInviteLinkCreateResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getActiveTeamInviteLinkForCreator(teamId, createdByUserId);
      if (existing) {
        if (existing.maxUses !== maxUses) {
          throw new RelayError("team_invite_link_max_uses_conflict", "An active invitation link already exists with a different maximum use count or capacity mode; disable it before creating a new one", 409);
        }
        return { inviteLink: existing, outcome: "already_active" as const };
      }
      const now = nowIso();
      const result = await transaction.query<TeamInviteLink>(
        `INSERT INTO "team_invite_links" ("id", "team_id", "created_by_user_id", "max_uses", "used_count", "active_limit_exempt", "status", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, 0, 0, 'enabled', $5, $5)
         ON CONFLICT DO NOTHING RETURNING *`,
        [createId("til"), teamId, createdByUserId, maxUses, now],
      );
      if (result.rows[0]) return { inviteLink: mapPostgresRow<TeamInviteLink>(result.rows[0]), outcome: "created" as const };
      const concurrent = await transaction.getActiveTeamInviteLinkForCreator(teamId, createdByUserId);
      if (!concurrent) throw new Error("postgres_active_team_invite_link_readback_empty");
      if (concurrent.maxUses !== maxUses) {
        throw new RelayError("team_invite_link_max_uses_conflict", "An active invitation link already exists with a different maximum use count or capacity mode; disable it before creating a new one", 409);
      }
      return { inviteLink: concurrent, outcome: "already_active" as const };
    });
  }

  async getTeamInviteLink(id: string): Promise<TeamInviteLink | undefined> {
    return this.one<TeamInviteLink>(`SELECT * FROM "team_invite_links" WHERE "id" = $1`, [id]);
  }

  async listTeamInviteLinks(teamId: string): Promise<TeamInviteLink[]> {
    return this.rows<TeamInviteLink>(
      `SELECT * FROM "team_invite_links" WHERE "team_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
      [teamId],
    );
  }

  async listTeamInviteLinksByCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLink[]> {
    return this.rows<TeamInviteLink>(
      `SELECT * FROM "team_invite_links" WHERE "team_id" = $1 AND "created_by_user_id" = $2 ORDER BY "created_at" DESC, "id" DESC`,
      [teamId, createdByUserId],
    );
  }

  async pageTeamInviteLinks(teamId: string, input: { createdByUserId?: string; page?: number; pageSize?: number } = {}): Promise<Awaited<ReturnType<ApplicationOperationPort["pageTeamInviteLinks"]>>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const totalResult = await this.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM "team_invite_links"
       WHERE "team_id" = $1
         AND ($2 = '' OR "created_by_user_id" = $2)`,
      [teamId, input.createdByUserId ?? ""],
    );
    const total = safePostgresInteger(totalResult.rows[0]?.count, "postgres_invite_link_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const result = await this.query(
      `SELECT link."id", link."team_id", link."created_by_user_id", identity."email" AS "creator_email",
              link."max_uses", link."used_count", link."active_limit_exempt", link."status",
              link."created_at", link."updated_at"
       FROM "team_invite_links" link
       LEFT JOIN "user_controls" creator ON creator."id" = link."created_by_user_id"
       LEFT JOIN "user" identity ON identity."id" = creator."id"
       WHERE link."team_id" = $1
         AND ($2 = '' OR link."created_by_user_id" = $2)
       ORDER BY link."created_at" DESC, link."id" DESC
       LIMIT $3 OFFSET $4`,
      [teamId, input.createdByUserId ?? "", pageSize, (page - 1) * pageSize],
    );
    return { items: result.rows.map((row) => mapPostgresRow(row)), page, pageSize, total, totalPages };
  }

  async getActiveTeamInviteLinkForCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLink | undefined> {
    return this.one<TeamInviteLink>(
      `SELECT * FROM "team_invite_links"
       WHERE "team_id" = $1 AND "created_by_user_id" = $2 AND "status" = 'enabled'
       ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
      [teamId, createdByUserId],
    );
  }

  async disableTeamInviteLink(id: string): Promise<TeamInviteLink | undefined> {
    await this.query(
      `UPDATE "team_invite_links" SET "status" = 'disabled', "updated_at" = $2
       WHERE "id" = $1 AND "status" = 'enabled'`,
      [id, nowIso()],
    );
    return this.getTeamInviteLink(id);
  }

  async consumeTeamInviteLinkUse(id: string): Promise<TeamInviteLink> {
    const result = await this.query<TeamInviteLink>(
      `UPDATE "team_invite_links"
       SET "used_count" = "used_count" + 1,
           "status" = CASE WHEN "max_uses" IS NOT NULL AND "used_count" + 1 >= "max_uses" THEN 'disabled' ELSE 'enabled' END,
           "updated_at" = $2
       WHERE "id" = $1 AND "status" = 'enabled'
         AND "used_count" IS NOT NULL AND ("max_uses" IS NULL OR "used_count" < "max_uses")
       RETURNING *`,
      [id, nowIso()],
    );
    const row = result.rows[0];
    if (!row) throw new RelayError("team_invite_link_not_found", "Team invite link not found", 404);
    return mapPostgresRow<TeamInviteLink>(row);
  }

  async listEnabledTeamInviteLinksByCreator(teamId: string, createdByUserId: string): Promise<TeamInviteLink[]> {
    return (await this.listTeamInviteLinksByCreator(teamId, createdByUserId)).filter((link) => link.status === "enabled");
  }

  async listEnabledNonOwnerTeamInviteLinks(teamId: string, ownerId: string): Promise<TeamInviteLink[]> {
    return (await this.listTeamInviteLinks(teamId)).filter((link) => link.status === "enabled" && link.createdByUserId !== ownerId);
  }

  async isTeamMemberInvitesEnabled(teamId: string): Promise<boolean> {
    const permission = await this.findResourcePermission("team", teamId, "team.invite_link.create", "team", teamId, null);
    return permission?.status === "enabled";
  }

  async grantTeamMembership(teamId: string, userId: string, roles: readonly string[] = ["viewer"], byInviteLink: string | null = null): Promise<TeamMembership> {
    return this.withRetriedTransaction(async (transaction) => {
      await transaction.lockTeamMutationScope(teamId);
      const normalizedRoles = normalizePostgresMembershipRoles(roles);
      const now = nowIso();
      const result = await transaction.query<TeamMembership>(
        `INSERT INTO "team_memberships" ("id", "team_id", "user_id", "roles_json", "by_invite_link", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ("team_id", "user_id") DO NOTHING RETURNING *`,
        [createId("tm"), teamId, userId, JSON.stringify(normalizedRoles), byInviteLink, now, now],
      );
      const membership = result.rows[0]
        ? mapPostgresRow<TeamMembership>(result.rows[0])
        : await transaction.getTeamMembership(teamId, userId);
      if (!membership) throw new Error("postgres_team_membership_readback_empty");
      return membership;
    });
  }

  async grantTeamMembershipByInvite(teamId: string, userId: string, inviteLinkId: string): Promise<TeamMembership> {
    return this.grantTeamMembership(teamId, userId, ["viewer"], inviteLinkId);
  }

  async ensureFallbackTeamMembership(userId: string, audit: { actor: { actorType: "user" | "api_key" | "system"; actorId: string }; source: "owner" | "web" | "gateway" | "system"; requestId?: string | null }): Promise<{ membership: TeamMembership; created: boolean }> {
    return this.withRetriedTransaction(async (transaction) => {
      const available = await transaction.listAvailableTeamMemberships(userId);
      if (available[0]) return { membership: available[0], created: false };
      await transaction.lockTeamMutationScope("team_default");
      const defaultTeam = await transaction.getTeam("team_default");
      const bootstrapOwnerId = await transaction.activeBootstrapPlatformOwnerId();
      if (!defaultTeam || !(await transaction.isTeamAvailable(defaultTeam.id)) || !bootstrapOwnerId || defaultTeam.ownerId !== bootstrapOwnerId) {
        throw new RelayError("default_team_unavailable", "Default Team is unavailable", 503);
      }
      const existing = await transaction.getTeamMembership(defaultTeam.id, userId);
      if (existing) return { membership: existing, created: false };
      const now = nowIso();
      const result = await transaction.query<TeamMembership>(
        `INSERT INTO "team_memberships" ("id", "team_id", "user_id", "roles_json", "by_invite_link", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, NULL, $5, $5)
         ON CONFLICT ("team_id", "user_id") DO NOTHING RETURNING *`,
        [createId("tm"), defaultTeam.id, userId, JSON.stringify(["viewer"]), now],
      );
      const membership = result.rows[0]
        ? mapPostgresRow<TeamMembership>(result.rows[0])
        : await transaction.getTeamMembership(defaultTeam.id, userId);
      if (!membership) throw new RelayError("fallback_membership_failed", "Default Team membership could not be created", 500);
      if (result.rows[0]) {
        await transaction.audit({
          actor: audit.actor,
          action: "team_membership.fallback_join",
          resource: { resourceType: "team_membership", resourceId: membership.id },
          result: "success",
          source: audit.source,
          requestId: audit.requestId,
          metadata: { teamId: defaultTeam.id, reason: "no_enabled_team_membership" },
        });
      }
      return { membership, created: Boolean(result.rows[0]) };
    });
  }

  async deleteTeamMembership(teamId: string, userId: string): Promise<TeamMembership | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      await transaction.lockTeamMutationScope(teamId);
      const existing = await transaction.getTeamMembership(teamId, userId);
      if (!existing) return undefined;
      await transaction.query(`DELETE FROM "team_memberships" WHERE "team_id" = $1 AND "user_id" = $2`, [teamId, userId]);
      return existing;
    });
  }

  async updateTeamMembershipRoles(teamId: string, userId: string, roles: readonly string[]): Promise<TeamMembership | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      await transaction.lockTeamMutationScope(teamId);
      const result = await transaction.query<TeamMembership>(
        `UPDATE "team_memberships" SET "roles_json" = $3, "updated_at" = $4
         WHERE "team_id" = $1 AND "user_id" = $2 RETURNING *`,
        [teamId, userId, JSON.stringify(normalizePostgresMembershipRoles(roles)), nowIso()],
      );
      return result.rows[0] ? mapPostgresRow<TeamMembership>(result.rows[0]) : undefined;
    });
  }

  async listResourcePermissionsForResource(resourceType: string, resourceId: string): Promise<ResourcePermission[]> {
    return this.rows<ResourcePermission>(
      `SELECT * FROM "resource_permissions"
       WHERE "resource_type" = $1 AND "resource_id" = $2
       ORDER BY "created_at" ASC, "id" ASC`,
      [resourceType, resourceId],
    );
  }

  async updateTeamInviteEmailDomainPattern(teamId: string, pattern: string | null): Promise<Team> {
    const result = await this.query<Team>(
      `UPDATE "teams" SET "invite_email_domain_pattern" = $2, "updated_at" = $3 WHERE "id" = $1 RETURNING *`,
      [teamId, pattern, nowIso()],
    );
    const row = result.rows[0];
    if (!row) throw new RelayError("team_not_found", "Team not found", 404);
    return mapPostgresRow<Team>(row);
  }

  async updateUserAdminNote(id: string, adminNote: string | null): Promise<User | undefined> {
    return this.withTransaction(async (transaction) => {
      const updated = await transaction.updateRow<QueryResultRow>("user_controls", id, { adminNote, updatedAt: nowIso() });
      return updated ? transaction.getUser(id) : undefined;
    });
  }

  async updateUserApiKeyLimit(id: string, apiKeyLimit: number): Promise<User | undefined> {
    return this.withTransaction(async (transaction) => {
      const updated = await transaction.updateRow<QueryResultRow>("user_controls", id, { apiKeyLimit, updatedAt: nowIso() });
      return updated ? transaction.getUser(id) : undefined;
    });
  }

  async updateUserDelegatedCreationPermissions(id: string, input: { userCanCreateCustomProvider?: number; userCanCreateAccessPoint?: number }): Promise<User | undefined> {
    return this.withTransaction(async (transaction) => {
      const updated = await transaction.updateRow<QueryResultRow>("user_controls", id, { ...input, updatedAt: nowIso() });
      return updated ? transaction.getUser(id) : undefined;
    });
  }

  async updateUserStatus(id: string, status: string): Promise<User | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getUser(id);
      if (!existing) return undefined;
      if (status !== "enabled" && (await transaction.platformRolesForUser(id)).includes("owner")) {
        throw new RelayError("platform_owner_status_change_blocked", "Handover Platform Owner before disabling this user", 409);
      }
      const now = nowIso();
      const result = await transaction.query<User>(
        `UPDATE "user_controls"
         SET "status" = $2, "auth_version" = CASE WHEN "status" = 'enabled' AND $2 <> 'enabled' THEN "auth_version" + 1 ELSE "auth_version" END,
             "updated_at" = $3
         WHERE "id" = $1 RETURNING *`,
        [id, status, now],
      );
      if (!result.rows[0]) return undefined;
      if (existing.status === "enabled" && status !== "enabled") await transaction.revokeAllUserCredentials(id, now);
      return transaction.getUser(id);
    });
  }

  async getOrCreateWebAuthnUserHandle(input: {
    userId: string;
    candidateHandle: string;
    additionalCandidateHandles?: string[];
  }): Promise<WebAuthnUserHandle> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.one<WebAuthnUserHandle>(
        `SELECT * FROM "webauthn_user_handles" WHERE "user_id" = $1`,
        [input.userId],
      );
      if (existing) return existing;
      if (!(await transaction.getUser(input.userId))) throw new RelayError("user_not_found", "User not found", 404);
      for (const candidate of [input.candidateHandle, ...(input.additionalCandidateHandles ?? [])]) {
        const row: WebAuthnUserHandle = { userId: input.userId, userHandle: candidate, createdAt: nowIso() };
        await transaction.query(
          `INSERT INTO "webauthn_user_handles" ("user_id", "user_handle", "created_at")
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [row.userId, row.userHandle, row.createdAt],
        );
        const inserted = await transaction.one<WebAuthnUserHandle>(
          `SELECT * FROM "webauthn_user_handles" WHERE "user_id" = $1`,
          [input.userId],
        );
        if (inserted) return inserted;
      }
      throw new RelayError("passkey_user_handle_unavailable", "Unable to allocate a Passkey user handle", 500);
    });
  }

  async getWebAuthnUserHandle(userId: string): Promise<WebAuthnUserHandle | undefined> {
    return this.one<WebAuthnUserHandle>(`SELECT * FROM "webauthn_user_handles" WHERE "user_id" = $1`, [userId]);
  }

  async listPasskeyCredentials(userId: string, rpId?: string): Promise<PasskeyCredential[]> {
    return this.rows<PasskeyCredential>(
      rpId === undefined
        ? `SELECT * FROM "passkey_credentials" WHERE "user_id" = $1 ORDER BY "created_at" ASC, "id" ASC`
        : `SELECT * FROM "passkey_credentials" WHERE "user_id" = $1 AND "rp_id" = $2 ORDER BY "created_at" ASC, "id" ASC`,
      rpId === undefined ? [userId] : [userId, rpId],
    );
  }

  async getPasskeyCredential(id: string): Promise<PasskeyCredential | undefined> {
    return this.one<PasskeyCredential>(`SELECT * FROM "passkey_credentials" WHERE "id" = $1`, [id]);
  }

  async getPasskeyCredentialByCredentialId(credentialId: string): Promise<PasskeyCredential | undefined> {
    return this.one<PasskeyCredential>(`SELECT * FROM "passkey_credentials" WHERE "credential_id" = $1`, [credentialId]);
  }

  async createWebAuthnCeremony(input: Omit<WebAuthnCeremony, "createdAt"> & { createdAt?: string }, cleanupLimit = 100): Promise<WebAuthnCeremony> {
    void input;
    void cleanupLimit;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const createdAt = input.createdAt ?? nowIso();
      await transaction.query(
        `DELETE FROM "webauthn_ceremonies"
         WHERE "session_hash" IN (
           SELECT "session_hash" FROM "webauthn_ceremonies"
           WHERE "expires_at" <= $1 ORDER BY "expires_at" ASC, "session_hash" ASC LIMIT $2
         )`,
        [createdAt, cleanupLimit],
      );
      return transaction.insertRow<WebAuthnCeremony>("webauthn_ceremonies", { ...input, createdAt });
    });
  }

  async takeWebAuthnCeremony(input: {
    sessionHash: string;
    purpose: WebAuthnCeremony["purpose"];
    surface: WebAuthnCeremony["surface"];
    now?: string;
  }): Promise<WebAuthnCeremony | undefined> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const result = await transaction.query<WebAuthnCeremony>(
        `DELETE FROM "webauthn_ceremonies"
         WHERE "session_hash" = $1 AND "purpose" = $2 AND "surface" = $3
         RETURNING *`,
        [input.sessionHash, input.purpose, input.surface],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const ceremony = mapPostgresRow<WebAuthnCeremony>(row);
      return ceremony.expiresAt > (input.now ?? nowIso()) ? ceremony : undefined;
    });
  }

  async createRefreshToken(input: { userId: string; tokenHash: string; expiresAt: string }): Promise<RefreshToken> {
    void input;
    throw new RelayError("auth_method_retired", "Friday refresh-token authentication has been retired", 404);
    return this.insertRow<RefreshToken>("refresh_tokens", {
      id: createId("rt"),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: nowIso(),
    });
  }

  async createRefreshTokenForAuthVersion(input: { userId: string; expectedAuthVersion: number; tokenHash: string; expiresAt: string }): Promise<RefreshToken> {
    void input;
    throw new RelayError("auth_method_retired", "Friday refresh-token authentication has been retired", 404);
  }

  async getRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    return this.one<RefreshToken>(`SELECT * FROM "refresh_tokens" WHERE "token_hash" = $1`, [tokenHash]);
  }

  async rotateRefreshToken(input: {
    tokenHash: string;
    userId: string;
    expectedAuthVersion: number;
    replacementTokenHash: string;
    replacementExpiresAt: string;
  }): Promise<RefreshToken | undefined> {
    void input;
    throw new RelayError("auth_method_retired", "Friday refresh-token authentication has been retired", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const rotatedAt = nowIso();
      const consumed = await transaction.query(
        `UPDATE "refresh_tokens" SET "revoked_at" = $1
         WHERE "token_hash" = $2 AND "user_id" = $3 AND "revoked_at" IS NULL AND "expires_at" > $1
           AND EXISTS (SELECT 1 FROM "user_controls" WHERE "id" = $3 AND "status" = 'enabled' AND "auth_version" = $4)`,
        [rotatedAt, input.tokenHash, input.userId, input.expectedAuthVersion],
      );
      if (consumed.rowCount !== 1) return undefined;
      return transaction.insertRow<RefreshToken>("refresh_tokens", {
        id: createId("rt"),
        userId: input.userId,
        tokenHash: input.replacementTokenHash,
        expiresAt: input.replacementExpiresAt,
        revokedAt: null,
        createdAt: rotatedAt,
      });
    });
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    void tokenHash;
    throw new RelayError("auth_method_retired", "Friday refresh-token authentication has been retired", 404);
    await this.query(`UPDATE "refresh_tokens" SET "revoked_at" = $2 WHERE "token_hash" = $1 AND "revoked_at" IS NULL`, [tokenHash, nowIso()]);
  }

  async registerUserPasskey(input: {
    userId: string;
    expectedAuthVersion: number;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transportsJson: string;
    deviceType: PasskeyCredential["deviceType"];
    backedUp: number;
    rpId: string;
    name: string;
    source: "web" | "owner";
    requestId?: string | null | undefined;
  }): Promise<PasskeyCredential> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const user = await transaction.assertEnabledUserAuthVersion(input.userId, input.expectedAuthVersion);
      if ((await transaction.listPasskeyCredentials(user.id, input.rpId)).length >= 10 || (await transaction.listPasskeyCredentials(user.id)).length >= 20) {
        throw new RelayError("passkey_limit_reached", "Passkey limit reached", 409);
      }
      if (await transaction.getPasskeyCredentialByCredentialId(input.credentialId)) {
        throw new RelayError("passkey_already_registered", "Passkey is already registered", 409);
      }
      const now = nowIso();
      const row = await transaction.insertRow<PasskeyCredential>("passkey_credentials", {
        id: createId("passkey"),
        userId: user.id,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        signCount: input.signCount,
        transportsJson: input.transportsJson,
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        rpId: input.rpId,
        name: input.name,
        createdAt: now,
        lastUsedAt: null,
        updatedAt: now,
      });
      await transaction.audit({
        actor: { actorType: "user", actorId: user.id },
        action: "auth.passkey.register",
        resource: { resourceType: "passkey", resourceId: row.id },
        result: "success",
        source: input.source,
        requestId: input.requestId,
        metadata: {},
      });
      return row;
    });
  }

  async listUserPasskeysAudited(input: { userId: string; expectedAuthVersion: number; source: "web" | "owner"; requestId?: string | null | undefined }): Promise<PasskeyCredential[]> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const user = await transaction.assertEnabledUserAuthVersion(input.userId, input.expectedAuthVersion);
      const rows = await transaction.listPasskeyCredentials(user.id);
      await transaction.audit({
        actor: { actorType: "user", actorId: user.id },
        action: "auth.passkey.list",
        resource: { resourceType: "user", resourceId: user.id },
        result: "success",
        source: input.source,
        requestId: input.requestId,
        metadata: { passkeyCount: rows.length },
      });
      return rows;
    });
  }

  async renameUserPasskey(input: { userId: string; expectedAuthVersion: number; passkeyId: string; name: string; source: "web" | "owner"; requestId?: string | null | undefined }): Promise<PasskeyCredential> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const user = await transaction.assertEnabledUserAuthVersion(input.userId, input.expectedAuthVersion);
      const result = await transaction.query<PasskeyCredential>(
        `UPDATE "passkey_credentials" SET "name" = $3, "updated_at" = $4
         WHERE "id" = $1 AND "user_id" = $2 RETURNING *`,
        [input.passkeyId, user.id, input.name, nowIso()],
      );
      const row = result.rows[0];
      if (!row) throw new RelayError("passkey_not_found", "Passkey not found", 404);
      const passkey = mapPostgresRow<PasskeyCredential>(row);
      await transaction.audit({
        actor: { actorType: "user", actorId: user.id },
        action: "auth.passkey.rename",
        resource: { resourceType: "passkey", resourceId: input.passkeyId },
        result: "success",
        source: input.source,
        requestId: input.requestId,
        metadata: {},
      });
      return passkey;
    });
  }

  async completePasskeyLogin(input: {
    userId: string;
    expectedAuthVersion: number;
    passkeyId: string;
    credentialId: string;
    rpId: string;
    expectedUpdatedAt: string;
    expectedSignCount: number;
    newSignCount: number;
    deviceType: PasskeyCredential["deviceType"];
    backedUp: number;
    refreshTokenHash: string;
    refreshTokenExpiresAt: string;
    source: "web" | "owner";
    requestId?: string | null | undefined;
    auditMetadata: Record<string, unknown>;
  }): Promise<User> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const user = await transaction.assertEnabledUserAuthVersion(input.userId, input.expectedAuthVersion);
      const now = nowIso();
      const expectedUpdatedAtMs = Date.parse(input.expectedUpdatedAt);
      if (!Number.isFinite(expectedUpdatedAtMs)) throw new RelayError("invalid_credentials", "Invalid credentials", 401);
      const nextUpdatedAt = new Date(Math.max(Date.parse(now), expectedUpdatedAtMs + 1)).toISOString();
      const updated = await transaction.query<PasskeyCredential>(
        `UPDATE "passkey_credentials"
         SET "sign_count" = $1, "device_type" = $2, "backed_up" = $3, "last_used_at" = $4, "updated_at" = $5
         WHERE "id" = $6 AND "user_id" = $7 AND "credential_id" = $8 AND "rp_id" = $9 AND "updated_at" = $10 AND "sign_count" = $11
         RETURNING *`,
        [input.newSignCount, input.deviceType, input.backedUp, now, nextUpdatedAt, input.passkeyId, user.id, input.credentialId, input.rpId, input.expectedUpdatedAt, input.expectedSignCount],
      );
      if (!updated.rows[0]) throw new RelayError("invalid_credentials", "Invalid credentials", 401);
      await transaction.insertRow<RefreshToken>("refresh_tokens", {
        id: createId("rt"), userId: user.id, tokenHash: input.refreshTokenHash,
        expiresAt: input.refreshTokenExpiresAt, revokedAt: null, createdAt: now,
      });
      await transaction.audit({
        actor: { actorType: "user", actorId: user.id },
        action: "auth.login",
        resource: { resourceType: "user", resourceId: user.id },
        result: "success",
        source: input.source,
        requestId: input.requestId,
        metadata: { ...input.auditMetadata, method: "passkey" },
      });
      return user;
    });
  }

  async deleteUserPasskeyAndRotateSession(input: {
    userId: string;
    expectedAuthVersion: number;
    expectedPasswordHash: string;
    passkeyId: string;
    newRefreshTokenHash: string;
    newRefreshTokenExpiresAt: string;
    source: "web" | "owner";
    requestId?: string | null | undefined;
  }): Promise<User> {
    void input;
    throw new RelayError("auth_method_retired", "Passkey authentication is no longer available", 404);
  }

  async rotateOwnPassword(input: {
    userId: string;
    expectedPasswordHash: string;
    newPasswordHash: string;
    newRefreshTokenHash: string;
    newRefreshTokenExpiresAt: string;
    surface: "web" | "owner";
    requestId?: string | null | undefined;
  }): Promise<User> {
    void input;
    throw new RelayError("auth_method_retired", "Friday JWT password changes have been retired; use Better Auth", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const now = nowIso();
      const credential = await transaction.query<{ userId: string }>(
        `UPDATE "account" SET "password" = $2, "updated_at" = $3
         WHERE "user_id" = $1 AND "provider_id" = 'credential' AND "password" = $4
         RETURNING "user_id" AS "userId"`,
        [input.userId, input.newPasswordHash, now, input.expectedPasswordHash],
      );
      if (!credential.rows[0]) throw new RelayError("current_password_invalid", "Current password is invalid", 400);
      const updated = await transaction.query(
        `UPDATE "user_controls" SET "auth_version" = "auth_version" + 1, "updated_at" = $2
         WHERE "id" = $1 AND "status" = 'enabled' RETURNING "id"`,
        [input.userId, now],
      );
      if (!updated.rows[0]) throw new RelayError("user_not_found", "Enabled user not found", 404);
      await transaction.revokeAllUserCredentials(input.userId, now);
      await transaction.audit({
        actor: { actorType: "user", actorId: input.userId },
        action: "auth.password_change",
        resource: { resourceType: "user", resourceId: input.userId },
        result: "success",
        source: input.surface,
        requestId: input.requestId,
        metadata: { surface: input.surface, otherSessionsRevoked: true },
      });
      const user = await transaction.getUser(input.userId);
      if (!user) throw new Error("postgres_password_change_readback_empty");
      return user;
    });
  }

  async createOidcAuthorizationCode(input: {
    codeHash: string;
    userId: string;
    clientId: string;
    redirectUri: string;
    scope: string;
    codeChallenge: string;
    nonce: string;
    expiresAt: string;
  }): Promise<OidcAuthorizationCode> {
    void input;
    throw new RelayError("auth_method_retired", "OIDC authentication is no longer available", 404);
    return this.insertRow<OidcAuthorizationCode>("oidc_authorization_codes", {
      id: createId("oidc_code"),
      ...input,
      createdAt: nowIso(),
      consumedAt: null,
    });
  }

  async getOidcAuthorizationCodeByHash(codeHash: string): Promise<OidcAuthorizationCode | undefined> {
    return this.one<OidcAuthorizationCode>(`SELECT * FROM "oidc_authorization_codes" WHERE "code_hash" = $1`, [codeHash]);
  }

  async exchangeOidcAuthorizationCode(input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    accessTokenHash: string;
    accessTokenAudience: string;
    accessTokenExpiresAt: string;
    refreshToken?: { tokenHash: string; familyId: string; expiresAt: string };
    now?: string;
  }): Promise<{ authorizationCode: OidcAuthorizationCode; accessToken: OidcAccessToken; refreshToken: OidcRefreshToken | null; user: User }> {
    void input;
    throw new RelayError("auth_method_retired", "OIDC authentication is no longer available", 404);
    return this.withRetriedTransaction(async (transaction) => {
      const now = input.now ?? nowIso();
      const authorizationCode = await transaction.getOidcAuthorizationCodeByHash(input.codeHash);
      if (!authorizationCode || authorizationCode.consumedAt || authorizationCode.expiresAt <= now || authorizationCode.clientId !== input.clientId || authorizationCode.redirectUri !== input.redirectUri || authorizationCode.codeChallenge !== input.codeChallenge) {
        throw new RelayError("invalid_grant", "Invalid authorization grant", 400);
      }
      const user = await transaction.getUser(authorizationCode.userId);
      if (!user || user.status !== "enabled") throw new RelayError("invalid_grant", "Invalid authorization grant", 400);
      const consumed = await transaction.query<OidcAuthorizationCode>(
        `UPDATE "oidc_authorization_codes" SET "consumed_at" = $2
         WHERE "id" = $1 AND "consumed_at" IS NULL RETURNING *`,
        [authorizationCode.id, now],
      );
      if (!consumed.rows[0]) throw new RelayError("invalid_grant", "Invalid authorization grant", 400);
      const accessToken = await transaction.insertRow<OidcAccessToken>("oidc_access_tokens", {
        id: createId("oidc_access"),
        tokenHash: input.accessTokenHash,
        userId: user.id,
        clientId: authorizationCode.clientId,
        audience: input.accessTokenAudience,
        scope: authorizationCode.scope,
        createdAt: now,
        expiresAt: input.accessTokenExpiresAt,
        revokedAt: null,
      });
      const refreshToken = input.refreshToken
        ? await transaction.insertRow<OidcRefreshToken>("oidc_refresh_tokens", {
          id: createId("oidc_refresh"),
          tokenHash: input.refreshToken.tokenHash,
          familyId: input.refreshToken.familyId,
          userId: user.id,
          clientId: authorizationCode.clientId,
          scope: authorizationCode.scope,
          createdAt: now,
          expiresAt: input.refreshToken.expiresAt,
          consumedAt: null,
          revokedAt: null,
          replacedById: null,
        })
        : null;
      return { authorizationCode: mapPostgresRow<OidcAuthorizationCode>(consumed.rows[0]), accessToken, refreshToken, user };
    });
  }

  async getOidcAccessTokenByHash(tokenHash: string): Promise<OidcAccessToken | undefined> {
    return this.one<OidcAccessToken>(`SELECT * FROM "oidc_access_tokens" WHERE "token_hash" = $1`, [tokenHash]);
  }

  async revokeOidcAccessToken(tokenHash: string, clientId: string): Promise<void> {
    void tokenHash;
    void clientId;
    throw new RelayError("auth_method_retired", "OIDC authentication is no longer available", 404);
    await this.query(
      `UPDATE "oidc_access_tokens" SET "revoked_at" = $3
       WHERE "token_hash" = $1 AND "client_id" = $2 AND "revoked_at" IS NULL`,
      [tokenHash, clientId, nowIso()],
    );
  }

  async getOidcRefreshTokenByHash(tokenHash: string): Promise<OidcRefreshToken | undefined> {
    return this.one<OidcRefreshToken>(`SELECT * FROM "oidc_refresh_tokens" WHERE "token_hash" = $1`, [tokenHash]);
  }

  async rotateOidcRefreshToken(input: {
    tokenHash: string;
    clientId: string;
    newTokenHash: string;
    accessTokenHash: string;
    accessTokenAudience: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    now?: string;
  }): Promise<{ status: "rotated"; accessToken: OidcAccessToken; refreshToken: OidcRefreshToken; user: User } | { status: "invalid" | "replayed" }> {
    void input;
    throw new RelayError("auth_method_retired", "OIDC authentication is no longer available", 404);
  }

  async revokeOidcRefreshToken(tokenHash: string, clientId: string): Promise<void> {
    void tokenHash;
    void clientId;
    throw new RelayError("auth_method_retired", "OIDC authentication is no longer available", 404);
  }

  async deleteExpiredOidcState(now = nowIso()): Promise<{ authorizationCodes: number; accessTokens: number; refreshTokens: number }> {
    void now;
    throw new RelayError("auth_method_retired", "OIDC authentication is no longer available", 404);
  }

  async platformRolesForUser(userId: string): Promise<string[]> {
    const now = nowIso();
    const row = await this.one<{ id: string }>(
      `SELECT "id" FROM "authority_grants"
       WHERE "beneficiary_user_id" = $1 AND "role_domain" = 'platform' AND "role_code" = 'owner'
         AND "source_kind" = 'system_bootstrap' AND "lifecycle" = 'active'
         AND "effective_start" <= $2
         AND ("effective_end" IS NULL OR "effective_end" > $2)
       LIMIT 1`,
      [userId, now],
    );
    return row ? ["owner"] : [];
  }

  async teamRolesForUser(userId: string): Promise<string[]> {
    const rows = await this.query<{ id: string }>(
      `SELECT team."id" FROM "teams" team
       WHERE team."owner_id" = $1 AND team."status" = 'enabled'
         AND NOT EXISTS (
           SELECT 1 FROM "team_deletion_lifecycles" deletion
           WHERE deletion."team_id" = team."id" AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
         )
       ORDER BY team."created_at" ASC, team."id" ASC`,
      [userId],
    );
    return rows.rows.map((row) => `owner:${row.id}`);
  }

  async canUserSetCardReferenceCode(userId: string): Promise<boolean> {
    const result = await this.query(
      `SELECT 1 FROM "teams" team
       WHERE team."owner_id" = $1 AND team."status" = 'enabled'
         AND NOT EXISTS (
           SELECT 1 FROM "team_deletion_lifecycles" deletion
           WHERE deletion."team_id" = team."id" AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
         ) LIMIT 1`,
      [userId],
    );
    return result.rows.length > 0;
  }

  async activeBootstrapPlatformOwnerId(): Promise<string | null> {
    const now = nowIso();
    const result = await this.query<{ userId: string }>(
      `SELECT grant_row."beneficiary_user_id" AS "userId"
       FROM "authority_grants" grant_row
       INNER JOIN "user_controls" user_row ON user_row."id" = grant_row."beneficiary_user_id" AND user_row."status" = 'enabled'
       WHERE grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
         AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
         AND grant_row."effective_start" <= $1
         AND (grant_row."effective_end" IS NULL OR grant_row."effective_end" > $1)
       ORDER BY grant_row."created_at", grant_row."id"`,
      [now],
    );
    return result.rows.length === 1 ? result.rows[0]!.userId : null;
  }

  async ensurePlatformOwnerGrant(userId: string): Promise<BootstrapOwnerGrant> {
    const user = await this.getUser(userId);
    if (!user || user.status !== "enabled") throw new RelayError("user_not_found", "Enabled Platform Owner user not found", 404);
    const existing = await this.one<BootstrapOwnerGrant>(
      `SELECT * FROM "authority_grants"
       WHERE "beneficiary_user_id" = $1 AND "role_domain" = 'platform' AND "role_code" = 'owner'
         AND "source_kind" = 'system_bootstrap' AND "lifecycle" = 'active'`,
      [userId],
    );
    if (existing) return existing;
    const activeOwner = await this.activeBootstrapPlatformOwnerId();
    if (activeOwner && activeOwner !== userId) throw new RelayError("platform_owner_already_exists", "An enabled Platform Owner already exists", 409);
    const now = nowIso();
    return this.insertRow<BootstrapOwnerGrant>("authority_grants", {
      id: createId("authority_grant"),
      beneficiaryUserId: userId,
      roleDomain: "platform",
      roleCode: "owner",
      roleScopeId: null,
      sourceKind: "system_bootstrap",
      sourcePurchaseId: null,
      sourceProductCodeSnapshot: null,
      sourceProductVersionSnapshot: null,
      sourceOriginIdSnapshot: null,
      maxCurrentOwnedTeamsSnapshot: null,
      maxLifetimeCreatedTeamsSnapshot: null,
      issuedByUserId: null,
      effectiveStart: now,
      effectiveEnd: null,
      lifecycle: "active",
      canceledAt: null,
      canceledByUserId: null,
      cancelReasonCode: null,
      createdAt: now,
    });
  }

  async handoverPlatformOwner(input: { currentOwnerUserId: string; nextOwnerUserId: string }): Promise<BootstrapOwnerGrant> {
    if (input.currentOwnerUserId === input.nextOwnerUserId) {
      throw new RelayError("platform_owner_handover_invalid", "Next Platform Owner must be a different user", 400);
    }
    return this.withRetriedTransaction(async (transaction) => {
      const current = await transaction.one<AuthorityGrant>(
        `SELECT * FROM "authority_grants"
         WHERE "beneficiary_user_id" = $1 AND "role_domain" = 'platform' AND "role_code" = 'owner'
           AND "source_kind" = 'system_bootstrap' AND "lifecycle" = 'active'
         FOR UPDATE`,
        [input.currentOwnerUserId],
      );
      if (!current) throw new RelayError("platform_owner_not_found", "Current Platform Owner Grant not found", 404);
      const next = await transaction.getUser(input.nextOwnerUserId);
      if (!next || next.status !== "enabled") {
        throw new RelayError("platform_owner_handover_target_invalid", "Next Platform Owner must be an enabled user", 409);
      }
      const now = nowIso();
      await transaction.query(
        `UPDATE "authority_grants"
         SET "lifecycle" = 'canceled', "canceled_at" = $2, "canceled_by_user_id" = $3, "cancel_reason_code" = 'owner_handover'
         WHERE "id" = $1`,
        [current.id, now, next.id],
      );
      const grant = await transaction.ensurePlatformOwnerGrant(next.id);
      await transaction.audit({
        actor: { actorType: "user", actorId: current.beneficiaryUserId },
        action: "platform_owner.handover",
        resource: { resourceType: "authority_grant", resourceId: grant.id },
        result: "success",
        source: "owner",
        metadata: { previousOwnerUserId: current.beneficiaryUserId, nextOwnerUserId: next.id, previousGrantId: current.id },
      });
      return grant;
    });
  }

  private async audit(input: AuditApplicationEvent): Promise<void> {
    await new PostgresAuditEventAppender().append({
      query: (text, values) => this.query(text, values),
    }, input);
  }

  async listApiKeys(userId?: string): Promise<ApiKey[]> {
    return this.rows<ApiKey>(userId === undefined
      ? `SELECT * FROM "api_keys" ORDER BY "created_at" ASC, "id" ASC`
      : `SELECT * FROM "api_keys" WHERE "user_id" = $1 ORDER BY "created_at" ASC, "id" ASC`, userId === undefined ? [] : [userId]);
  }

  async getApiKey(id: string): Promise<ApiKey | undefined> {
    return this.one<ApiKey>(`SELECT * FROM "api_keys" WHERE "id" = $1`, [id]);
  }

  async listApiKeySummariesByIds(
    userId: string,
    ids: string[],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["listApiKeySummariesByIds"]>>> {
    const uniqueIds = [...new Set(ids)].slice(0, 50);
    if (uniqueIds.length === 0) return [];
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listApiKeySummariesByIds"]>>[number]>(
      `SELECT "id", "user_id" AS "userId", "name", "key_prefix" AS "keyPrefix",
              "status", "created_at" AS "createdAt"
       FROM "api_keys"
       WHERE "user_id" = $1 AND "id" = ANY($2::text[])
       ORDER BY "created_at" ASC, "id" ASC`,
      [userId, uniqueIds],
    );
  }

  async searchTeamProviderPurchaseCandidates(
    userId: string,
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchTeamProviderPurchaseCandidates"]>>> {
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const pageSize = 20;
    const now = nowIso();
    const filter = `
      FROM "team_memberships" membership
      INNER JOIN "teams" team ON team."id" = membership."team_id"
      WHERE membership."user_id" = $1
        AND team."status" = 'enabled'
        AND (team."owner_id" = $1 OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(membership."roles_json"::jsonb) role
          WHERE lower(role) = 'billing'
        ))
        AND ($2 = '' OR position($2 IN lower(team."id")) > 0 OR position($2 IN lower(team."name")) > 0)
    `;
    const total = (await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" ${filter}`, [userId, normalized]))?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchTeamProviderPurchaseCandidates"]>>["items"][number]>(
      `SELECT team."id", team."name",
              CASE WHEN team."owner_id" = $1 THEN 'Owner' ELSE 'Billing' END AS "role",
              CASE WHEN EXISTS (
                SELECT 1 FROM "team_provider_entitlements" entitlement
                WHERE entitlement."team_id" = team."id"
                  AND entitlement."entitlement_lifecycle" = 'active'
                  AND entitlement."effective_start" <= $3
                  AND entitlement."effective_end" IS NULL
              ) THEN 1 ELSE 0 END AS "permanent",
              (SELECT MAX(entitlement."effective_end")
               FROM "team_provider_entitlements" entitlement
               WHERE entitlement."team_id" = team."id"
                 AND entitlement."entitlement_lifecycle" = 'active'
                 AND entitlement."effective_end" > $3) AS "currentEnd"
       ${filter}
       ORDER BY lower(team."name") ASC, team."id" ASC
       LIMIT $4 OFFSET $5`,
      [userId, normalized, now, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    return this.one<ApiKey>(`SELECT * FROM "api_keys" WHERE "key_hash" = $1`, [keyHash]);
  }

  async createApiKey(input: { userId: string; name: string; keyHash: string; keyPrefix: string; keyValue: string; expiresAt?: string | null }): Promise<ApiKey> {
    const now = nowIso();
    const row: ApiKey = {
      id: createId("key"),
      userId: input.userId,
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      keyValue: input.keyValue,
      status: "enabled",
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.insertRow<ApiKey>("api_keys", row);
  }

  async countEnabledApiKeysForUser(userId: string): Promise<number> {
    const result = await this.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM "api_keys" WHERE "user_id" = $1 AND "status" = 'enabled' AND "revoked_at" IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async revokeApiKey(id: string): Promise<ApiKey | undefined> {
    return this.updateRow<ApiKey>("api_keys", id, { status: "revoked", revokedAt: nowIso(), updatedAt: nowIso() });
  }

  async updateApiKeyStatus(id: string, status: "enabled" | "disabled"): Promise<ApiKey | undefined> {
    return this.updateRow<ApiKey>("api_keys", id, { status, updatedAt: nowIso() });
  }

  async listProviders(): Promise<Provider[]> {
    return this.rows<Provider>(`SELECT * FROM "providers" ORDER BY "created_at" ASC, "id" ASC`);
  }

  async pageProviderDirectory(
    input: Parameters<ApplicationOperationPort["pageProviderDirectory"]>[0] = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageProviderDirectory"]>>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const requestedPage = normalizeDirectoryPage(input.page, 10_000);
    const showRetained = input.showRetained === true;
    const cte = postgresProviderDirectoryCte();
    const totalRow = await this.one<{ count: number }>(
      cte + ' SELECT COUNT(*)::int AS "count" FROM directory',
      [showRetained],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_provider_directory_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(requestedPage, totalPages);
    type ProviderRow = Awaited<ReturnType<ApplicationOperationPort["pageProviderDirectory"]>>["items"][number];
    type ProviderBindingRow = NonNullable<ProviderRow["binding"]>;
    type RawProviderRow = Omit<ProviderRow, "binding" | "deletionState" | "modelNames"> & {
      authMethod: string | null;
      credentialOwnership: string | null;
      credentialPreview: string | null;
      revision: number | null;
      syncStatus: string | null;
      errorCode: string | null;
      bindingUpdatedAt: string | null;
      modelCount: number;
      modelNames: string[] | null;
      hasAccessPointReferences: boolean;
      hasOnlineBillingHistory: boolean;
      credentialCleared: boolean;
    };
    const rows = await this.rows<RawProviderRow>(
      cte + '\n SELECT * FROM directory\n ORDER BY "createdAt" ASC, "id" ASC\n LIMIT $2 OFFSET $3',
      [showRetained, pageSize, (page - 1) * pageSize],
    );
    const items = rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      scopeRef: row.scopeRef,
      name: row.name,
      kind: row.kind,
      status: row.status,
      baseUrlResolver: row.baseUrlResolver,
      credentialResolver: row.credentialResolver,
      modelsResolver: row.modelsResolver,
      configJson: row.configJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      binding: row.authMethod === null || row.credentialOwnership === null || row.revision === null || row.syncStatus === null || row.bindingUpdatedAt === null ? null : {
        authMethod: row.authMethod as ProviderBindingRow["authMethod"],
        credentialOwnership: row.credentialOwnership as ProviderBindingRow["credentialOwnership"],
        credentialPreview: row.credentialPreview,
        revision: row.revision,
        syncStatus: row.syncStatus as ProviderBindingRow["syncStatus"],
        errorCode: row.errorCode,
        updatedAt: row.bindingUpdatedAt,
      },
      modelCount: Number(row.modelCount),
      modelNames: row.modelNames ?? [],
      deletionState: {
        hasAccessPointReferences: row.hasAccessPointReferences,
        hasOnlineBillingHistory: row.hasOnlineBillingHistory,
        credentialCleared: row.credentialCleared,
        retained: row.status === "disabled" && row.hasOnlineBillingHistory,
      },
    })) as ProviderRow[];
    return { items, page, pageSize, total, totalPages };
  }

  async getProviderDirectorySummary(): Promise<Awaited<ReturnType<ApplicationOperationPort["getProviderDirectorySummary"]>>> {
    const row = await this.one<{ providerCount: number; enabledProviderCount: number; registeredModelCount: number; retainedProviderCount: number }>(
      'SELECT COUNT(*)::int AS "providerCount",\n' +
      '       COALESCE(SUM(CASE WHEN "status" = \'enabled\' THEN 1 ELSE 0 END), 0)::int AS "enabledProviderCount",\n' +
      '       COALESCE(SUM(CASE WHEN "status" = \'disabled\' AND EXISTS(\n' +
      '         SELECT 1 FROM "billing_provider_cost_events" cost_event WHERE cost_event."provider_id" = providers."id"\n' +
      '       ) THEN 1 ELSE 0 END), 0)::int AS "retainedProviderCount",\n' +
      '       (SELECT COUNT(*)::int FROM "provider_models") AS "registeredModelCount"\n' +
      ' FROM "providers"',
      [],
    );
    return {
      providerCount: safePostgresInteger(row?.providerCount ?? 0, "postgres_provider_count_invalid"),
      enabledProviderCount: safePostgresInteger(row?.enabledProviderCount ?? 0, "postgres_enabled_provider_count_invalid"),
      registeredModelCount: safePostgresInteger(row?.registeredModelCount ?? 0, "postgres_registered_model_count_invalid"),
      retainedProviderCount: safePostgresInteger(row?.retainedProviderCount ?? 0, "postgres_retained_provider_count_invalid"),
    };
  }

  async searchProviderCandidates(
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchProviderCandidates"]>>> {
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const pageSize = 20;
    const filter = `WHERE "status" = 'enabled'
      AND ($1 = '' OR strpos(lower("id"), $1) > 0 OR strpos(lower("name"), $1) > 0 OR strpos(lower("kind"), $1) > 0)`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "providers" ${filter}`, [normalized]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_provider_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchProviderCandidates"]>>["items"][number]>(
      `SELECT "id", "name", "kind", "status"
       FROM "providers" ${filter}
       ORDER BY lower("name") ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageProviderModels(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageProviderModels"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "provider_models"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_provider_model_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageProviderModels"]>>["items"][number]>(
      `SELECT "id", "provider_id" AS "providerId", "provider_model_name" AS "providerModelName",
              "display_name" AS "displayName", "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "provider_models"
       ORDER BY "provider_model_name" ASC, "id" ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageAccessPointDirectory(
    input: Parameters<ApplicationOperationPort["pageAccessPointDirectory"]>[0] = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageAccessPointDirectory"]>>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const requestedPage = normalizeDirectoryPage(input.page, 10_000);
    const filter = `WHERE "removed_at" IS NULL AND ($1 = ''
      OR strpos(lower("id"), $1) > 0
      OR strpos(lower("name"), $1) > 0
      OR strpos(lower("scope_ref"), $1) > 0
      OR strpos(lower("exposed_model"), $1) > 0
      OR strpos(lower("target_model"), $1) > 0
      OR strpos(lower("target_provider_id"), $1) > 0
      OR strpos(lower("target_provider_model_name"), $1) > 0
      OR strpos(lower("status"), $1) > 0)`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "access_points" ${filter}`, [query]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_access_point_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(requestedPage, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageAccessPointDirectory"]>>["items"][number]>(
      `SELECT "id", "owner_id" AS "ownerId", "scope_ref" AS "scopeRef", "name",
              "api_family" AS "apiFamily", "exposed_model" AS "exposedModel", "target_model" AS "targetModel",
              "selector_id" AS "selectorId", "selector_behavior_version" AS "selectorBehaviorVersion",
              "selector_config_json" AS "selectorConfigJson", "request_overrides_json" AS "requestOverridesJson",
              "routing_revision" AS "routingRevision",
              "target_type" AS "targetType", "target_id" AS "targetId",
              "target_provider_id" AS "targetProviderId", "target_provider_model_name" AS "targetProviderModelName",
              "priority", "weight", "fallback_order" AS "fallbackOrder", "status",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "access_points" ${filter}
       ORDER BY "priority" ASC, "fallback_order" ASC, "created_at" ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async searchAccessPointCandidates(
    query = "",
    page = 1,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["searchAccessPointCandidates"]>>> {
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const pageSize = 20;
    const filter = `WHERE "status" = 'enabled' AND "removed_at" IS NULL
      AND ($1 = '' OR strpos(lower("id"), $1) > 0 OR strpos(lower("name"), $1) > 0
        OR strpos(lower("scope_ref"), $1) > 0 OR strpos(lower("exposed_model"), $1) > 0)`;
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "access_points" ${filter}`, [normalized]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_access_point_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["searchAccessPointCandidates"]>>["items"][number]>(
      `SELECT "id", "name", "scope_ref" AS "scopeRef", "exposed_model" AS "exposedModel", "status"
       FROM "access_points" ${filter}
       ORDER BY lower("name") ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageEffectiveAccessPointsForTeam(
    teamId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageEffectiveAccessPointsForTeam"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const teamScopeRef = `team:${teamId}`;
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "access_points"
       WHERE "status" = 'enabled' AND "removed_at" IS NULL AND "scope_ref" IN ('global:', $1)`,
      [teamScopeRef],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_effective_access_point_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageEffectiveAccessPointsForTeam"]>>["items"][number]>(
      `SELECT "id" AS "accessPointId", "owner_id" AS "ownerId", "scope_ref" AS "scopeRef",
              $1 AS "visibleToScopeRef", "name" AS "displayName", "description", "api_family" AS "apiFamily",
              "exposed_model" AS "exposedModel"
       FROM "access_points"
       WHERE "status" = 'enabled' AND "removed_at" IS NULL AND "scope_ref" IN ('global:', $1)
       ORDER BY "priority" ASC, "fallback_order" ASC, "created_at" ASC, "id" ASC
       LIMIT $2 OFFSET $3`,
      [teamScopeRef, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageScopedAccessPointPrices(
    scopeRef: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageScopedAccessPointPrices"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count"
       FROM "access_point_prices" price
       INNER JOIN "access_points" access_point ON access_point."id" = price."access_point_id"
       WHERE access_point."scope_ref" = $1`,
      [scopeRef],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_scoped_access_point_price_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageScopedAccessPointPrices"]>>["items"][number]>(
      `SELECT price."id", price."access_point_id" AS "accessPointId",
              price."input_per_1m" AS "inputPer1M", price."cached_input_per_1m" AS "cachedInputPer1M",
              price."cache_write_per_1m" AS "cacheWritePer1M", price."output_per_1m" AS "outputPer1M",
              price."status", price."created_at" AS "createdAt", price."updated_at" AS "updatedAt",
              access_point."name" AS "accessPointName", access_point."scope_ref" AS "accessPointScopeRef"
       FROM "access_point_prices" price
       INNER JOIN "access_points" access_point ON access_point."id" = price."access_point_id"
       WHERE access_point."scope_ref" = $1
       ORDER BY price."created_at" DESC, price."id" DESC
       LIMIT $2 OFFSET $3`,
      [scopeRef, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageProviderModelCosts(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageProviderModelCosts"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "provider_model_costs"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_provider_cost_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageProviderModelCosts"]>>["items"][number]>(
      `SELECT "id", "provider_id" AS "providerId", "provider_model_name" AS "providerModelName",
              "input_per_1m" AS "inputPer1M", "cached_input_per_1m" AS "cachedInputPer1M",
              "cache_write_per_1m" AS "cacheWritePer1M", "output_per_1m" AS "outputPer1M",
              "source", "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "provider_model_costs"
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageAccessPointPrices(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageAccessPointPrices"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "access_point_prices"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_access_point_price_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageAccessPointPrices"]>>["items"][number]>(
      `SELECT "id", "access_point_id" AS "accessPointId", "input_per_1m" AS "inputPer1M",
              "cached_input_per_1m" AS "cachedInputPer1M", "cache_write_per_1m" AS "cacheWritePer1M",
              "output_per_1m" AS "outputPer1M", "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "access_point_prices"
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageScopedAccessPointDirectory(
    scopeRef: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<PageResult<ScopedAccessPointDirectoryRow>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "access_points" WHERE "scope_ref" = $1 AND "removed_at" IS NULL`,
      [scopeRef],
    ))?.count ?? 0, "postgres_scoped_access_point_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const rows = await this.rows<ScopedAccessPointDirectoryRow & {
      enabledPriceId: string | null;
      enabledPriceAccessPointId: string | null;
      enabledPriceInputPer1M: number | null;
      enabledPriceCachedInputPer1M: number | null;
      enabledPriceCacheWritePer1M: number | null;
      enabledPriceOutputPer1M: number | null;
      enabledPriceStatus: string | null;
      enabledPriceCreatedAt: string | null;
      enabledPriceUpdatedAt: string | null;
    }>(
      `SELECT access_point.*, target_access_point."name" AS "targetAccessPointName",
              price."id" AS "enabledPriceId", price."access_point_id" AS "enabledPriceAccessPointId",
              price."input_per_1m" AS "enabledPriceInputPer1M", price."cached_input_per_1m" AS "enabledPriceCachedInputPer1M",
              price."cache_write_per_1m" AS "enabledPriceCacheWritePer1M", price."output_per_1m" AS "enabledPriceOutputPer1M",
              price."status" AS "enabledPriceStatus", price."created_at" AS "enabledPriceCreatedAt", price."updated_at" AS "enabledPriceUpdatedAt"
       FROM "access_points" access_point
       LEFT JOIN "access_points" target_access_point
         ON access_point."target_type" = 'access-point' AND target_access_point."id" = access_point."target_id"
       LEFT JOIN "access_point_prices" price ON price."id" = (
         SELECT latest."id" FROM "access_point_prices" latest
         WHERE latest."access_point_id" = access_point."id" AND latest."status" = 'enabled'
         ORDER BY latest."created_at" DESC, latest."id" DESC LIMIT 1
       )
       WHERE access_point."scope_ref" = $1 AND access_point."removed_at" IS NULL
       ORDER BY access_point."priority" ASC, access_point."fallback_order" ASC, access_point."created_at" ASC, access_point."id" ASC
       LIMIT $2 OFFSET $3`,
      [scopeRef, pageSize, (normalizedPage - 1) * pageSize],
    );
    const items = await Promise.all(rows.map(async (row) => ({
      id: row.id,
      ownerId: row.ownerId,
      scopeRef: row.scopeRef,
      name: row.name,
      description: row.description,
      apiFamily: row.apiFamily,
      exposedModel: row.exposedModel,
      targetModel: row.targetModel,
      selectorId: row.selectorId,
      selectorBehaviorVersion: row.selectorBehaviorVersion,
      selectorConfigJson: row.selectorConfigJson,
      requestOverridesJson: row.requestOverridesJson ?? "{}",
      routingRevision: row.routingRevision,
      targetType: row.targetType,
      targetId: row.targetId,
      targetProviderId: row.targetProviderId,
      targetProviderModelName: row.targetProviderModelName,
      priority: row.priority,
      weight: row.weight,
      fallbackOrder: row.fallbackOrder,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      targetAccessPointName: row.targetAccessPointName,
      enabledPrice: row.enabledPriceId
        ? {
            id: row.enabledPriceId,
            accessPointId: row.enabledPriceAccessPointId!,
            inputPer1M: row.enabledPriceInputPer1M!,
            cachedInputPer1M: row.enabledPriceCachedInputPer1M!,
            cacheWritePer1M: row.enabledPriceCacheWritePer1M,
            outputPer1M: row.enabledPriceOutputPer1M!,
            status: row.enabledPriceStatus!,
            createdAt: row.enabledPriceCreatedAt!,
            updatedAt: row.enabledPriceUpdatedAt!,
          }
        : null,
    })));
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pagePlanSubscriptionsForScope(
    scopeRef: string,
    page = 1,
    planStatus: TeamPlanStatusFilter = "all",
    requestedPageSize?: number,
  ): Promise<PageResult<TeamPlanSubscriptionDirectoryRow>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const values = [scopeRef, planStatus];
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "plan_subscriptions" subscription
       LEFT JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."scope_ref" = $1 AND ($2 = 'all' OR plan."plan_status" = $2)`,
      values,
    ))?.count ?? 0, "postgres_team_plan_subscription_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<TeamPlanSubscriptionDirectoryRow>(
      `SELECT subscription."id", subscription."plan_id" AS "planId", subscription."source",
              subscription."scope_ref" AS "scopeRef", subscription."priority",
              subscription."effective_start" AS "effectiveStart", subscription."effective_end" AS "effectiveEnd",
              subscription."subscription_lifecycle" AS "subscriptionLifecycle", subscription."created_at" AS "createdAt",
              plan."name" AS "templateName", plan."version" AS "templateVersion", plan."billing_mode" AS "billingMode",
              plan."plan_status" AS "planStatus", plan."purchase_amount" AS "purchaseAmount", plan."duration_seconds" AS "durationSeconds",
              (SELECT COUNT(*)::int FROM "plan_budget_limits" budget WHERE budget."plan_id" = subscription."plan_id") AS "budgetLimitCount",
              (SELECT COUNT(*)::int FROM "plan_access_points" relation WHERE relation."plan_id" = subscription."plan_id") AS "accessPointCount",
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'limitScope', preview."limitScope", 'metric', preview."metric", 'limitValue', preview."limitValue",
                'windowType', preview."windowType", 'windowSeconds', preview."windowSeconds"))
                FROM (SELECT budget."limit_scope" AS "limitScope", budget."metric", budget."limit_value" AS "limitValue",
                             budget."window_type" AS "windowType", budget."window_seconds" AS "windowSeconds"
                      FROM "plan_budget_limits" budget WHERE budget."plan_id" = subscription."plan_id"
                      ORDER BY CASE budget."limit_scope" WHEN 'subscription' THEN 0 ELSE 1 END,
                               CASE budget."metric" WHEN 'amount' THEN 0 ELSE 1 END,
                               budget."created_at" ASC, budget."id" ASC LIMIT 2) preview), '[]'::jsonb)::text AS "budgetLimitPreviewJson",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('name', preview."name", 'exposedModel', preview."exposedModel"))
                FROM (SELECT access_point."name", access_point."exposed_model" AS "exposedModel"
                      FROM "plan_access_points" relation INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
                      WHERE relation."plan_id" = subscription."plan_id"
                      ORDER BY lower(access_point."name") ASC, access_point."id" ASC LIMIT 3) preview), '[]'::jsonb)::text AS "accessPointPreviewJson"
       FROM "plan_subscriptions" subscription
       LEFT JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."scope_ref" = $1 AND ($2 = 'all' OR plan."plan_status" = $2)
       ORDER BY subscription."priority" ASC, subscription."effective_start" ASC, subscription."created_at" ASC, subscription."id" ASC
       LIMIT $3 OFFSET $4`,
      [...values, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async listDirectPermissionsForSubjects(
    resourceType: string,
    resourceId: string,
    subjectRefs: string[],
  ): Promise<ResourcePermissionDirectoryRow[]> {
    const uniqueRefs = [...new Set(subjectRefs)].slice(0, 50);
    if (uniqueRefs.length === 0) return [];
    return this.rows<ResourcePermissionDirectoryRow>(
      `SELECT "id", "resource_type" AS "resourceType", "resource_id" AS "resourceId", "action",
              "subject_type" AS "subjectType", "subject_ref" AS "subjectRef", "subject_role" AS "subjectRole",
              "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "resource_permissions"
       WHERE "resource_type" = $1 AND "resource_id" = $2 AND "subject_type" = 'user' AND "subject_ref" = ANY($3::text[])
       ORDER BY "action" ASC, "subject_ref" ASC, "id" ASC`,
      [resourceType, resourceId, uniqueRefs],
    );
  }

  async workbenchSummary(): Promise<PricingWorkbenchSummary> {
    const row = await this.one<PricingWorkbenchSummary>(
      `SELECT
         (SELECT COUNT(*)::int FROM "provider_models") AS "providerModelCount",
         (SELECT COUNT(*)::int FROM "provider_models" model
          WHERE model."status" = 'enabled'
            AND NOT EXISTS (
              SELECT 1 FROM "provider_model_costs" cost
              WHERE cost."provider_id" = model."provider_id"
                AND cost."provider_model_name" = model."provider_model_name"
                AND cost."status" = 'enabled'
            )) AS "missingEnabledProviderCostCount",
         (SELECT COUNT(*)::int FROM "access_points") AS "accessPointCount",
         (SELECT COUNT(*)::int FROM "access_points" access_point
          WHERE access_point."status" = 'enabled'
            AND NOT EXISTS (
              SELECT 1 FROM "access_point_prices" price
              WHERE price."access_point_id" = access_point."id"
                AND price."status" = 'enabled'
            )) AS "missingEnabledAccessPointPriceCount"`,
      [],
    );
    if (!row) throw new Error("postgres_pricing_workbench_summary_empty");
    return row;
  }

  async pageProviderCostWorkbench(input: ProviderCostWorkbenchInput = {}): Promise<ProviderCostWorkbenchPage> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const providerId = input.providerId && input.providerId !== "all" ? input.providerId : "";
    const modelStatus = input.modelStatus && input.modelStatus !== "all" ? input.modelStatus : "";
    const hasEnabledCost = `EXISTS (
      SELECT 1 FROM "provider_model_costs" cost
      WHERE cost."provider_id" = pm."provider_id"
        AND cost."provider_model_name" = pm."provider_model_name"
        AND cost."status" = 'enabled'
    )`;
    const conditions = [
      `($1 = '' OR position($1 IN lower(p."name")) > 0 OR position($1 IN lower(pm."provider_model_name")) > 0 OR position($1 IN lower(pm."display_name")) > 0)`,
      `($2 = '' OR pm."provider_id" = $2)`,
      `($3 = '' OR pm."status" = $3)`,
    ];
    if (input.price === "missing") conditions.push(`NOT ${hasEnabledCost}`);
    if (input.price === "has-enabled") conditions.push(hasEnabledCost);
    const filter = `WHERE ${conditions.join(" AND ")}`;
    const cte = `WITH directory AS (
      SELECT pm."provider_id" AS "providerId", p."name" AS "providerName",
             pm."provider_model_name" AS "providerModelName", pm."display_name" AS "displayName",
             pm."status" AS "modelStatus", ${hasEnabledCost} AS "hasEnabledCost"
      FROM "provider_models" pm
      INNER JOIN "providers" p ON p."id" = pm."provider_id"
      ${filter}
    )`;
    const values = [query, providerId, modelStatus];
    const summary = await this.one<{ total: number; missingEnabledCostCount: number }>(
      `${cte} SELECT COUNT(*)::int AS "total", COALESCE(SUM(CASE WHEN NOT "hasEnabledCost" THEN 1 ELSE 0 END), 0)::int AS "missingEnabledCostCount" FROM directory`,
      values,
    );
    const total = safePostgresInteger(summary?.total ?? 0, "postgres_provider_workbench_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const rows = await this.rows<Omit<ProviderCostWorkbenchRow, "enabledCost"> & { hasEnabledCost: boolean }>(
      `${cte} SELECT "providerId", "providerName", "providerModelName", "displayName", "modelStatus", "hasEnabledCost"
       FROM directory ORDER BY lower("providerName") ASC, lower("displayName") ASC, "providerId" ASC, "providerModelName" ASC
       LIMIT $4 OFFSET $5`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    const items = await Promise.all(rows.map(async (row) => ({
      providerId: row.providerId,
      providerName: row.providerName,
      providerModelName: row.providerModelName,
      displayName: row.displayName,
      modelStatus: row.modelStatus,
      enabledCost: row.hasEnabledCost
        ? await this.postgresEnabledProviderModelCost(row.providerId, row.providerModelName) ?? null
        : null,
    })));
    return { items, page, pageSize, total, totalPages, missingEnabledCostCount: safePostgresInteger(summary?.missingEnabledCostCount ?? 0, "postgres_provider_workbench_missing_count_invalid") };
  }

  async pageAccessPointPriceWorkbench(input: AccessPointPriceWorkbenchInput = {}): Promise<AccessPointPriceWorkbenchPage> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const status = input.status && input.status !== "all" ? input.status : "";
    const hasEnabledPrice = `EXISTS (
      SELECT 1 FROM "access_point_prices" price
      WHERE price."access_point_id" = ap."id" AND price."status" = 'enabled'
    )`;
    const hasEnabledTargetCost = `(
      (ap."target_type" = 'provider-model' AND EXISTS (
        SELECT 1 FROM "provider_model_costs" target_cost
        WHERE target_cost."provider_id" = ap."target_provider_id"
          AND target_cost."provider_model_name" = ap."target_provider_model_name"
          AND target_cost."status" = 'enabled'
      )) OR
      (ap."target_type" = 'access-point' AND EXISTS (
        SELECT 1 FROM "access_point_prices" target_price
        WHERE target_price."access_point_id" = ap."target_id" AND target_price."status" = 'enabled'
      ))
    )`;
    const conditions = [
      `ap."removed_at" IS NULL`,
      `($1 = '' OR position($1 IN lower(ap."name")) > 0 OR position($1 IN lower(ap."id")) > 0 OR position($1 IN lower(ap."scope_ref")) > 0)`,
      `($2 = '' OR ap."status" = $2)`,
    ];
    if (input.price === "missing") conditions.push(`NOT ${hasEnabledPrice}`);
    if (input.price === "has-enabled") conditions.push(hasEnabledPrice);
    if (input.targetCost === "missing") conditions.push(`NOT ${hasEnabledTargetCost}`);
    if (input.targetCost === "has-enabled") conditions.push(hasEnabledTargetCost);
    const filter = `WHERE ${conditions.join(" AND ")}`;
    const cte = `WITH directory AS (
      SELECT ap."id", ap."scope_ref" AS "scopeRef", ap."name", ap."description", ap."target_type" AS "targetType",
             ap."target_id" AS "targetId", ap."target_provider_id" AS "targetProviderId",
             ap."target_provider_model_name" AS "targetProviderModelName", ap."status",
             target_ap."name" AS "targetAccessPointName", ${hasEnabledPrice} AS "hasEnabledPrice"
      FROM "access_points" ap
      LEFT JOIN "access_points" target_ap ON ap."target_type" = 'access-point' AND target_ap."id" = ap."target_id"
      ${filter}
    )`;
    const values = [query, status];
    const summary = await this.one<{ total: number; missingEnabledPriceCount: number }>(
      `${cte} SELECT COUNT(*)::int AS "total", COALESCE(SUM(CASE WHEN NOT "hasEnabledPrice" THEN 1 ELSE 0 END), 0)::int AS "missingEnabledPriceCount" FROM directory`,
      values,
    );
    const total = safePostgresInteger(summary?.total ?? 0, "postgres_access_point_workbench_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const rows = await this.rows<Omit<AccessPointPriceWorkbenchRow, "enabledPrice" | "targetCost"> & { hasEnabledPrice: boolean }>(
      `${cte} SELECT "id", "scopeRef", "name", "description", "targetType", "targetId", "targetProviderId", "targetProviderModelName", "status", "targetAccessPointName", "hasEnabledPrice"
       FROM directory ORDER BY lower("name") ASC, "id" ASC LIMIT $3 OFFSET $4`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    const items = await Promise.all(rows.map(async (row) => {
      const [enabledPrice, targetCost] = await Promise.all([
        row.hasEnabledPrice ? this.postgresEnabledAccessPointPrice(row.id) : Promise.resolve(undefined),
        row.targetType === "provider-model" && row.targetProviderId && row.targetProviderModelName
          ? this.postgresEnabledProviderModelCost(row.targetProviderId, row.targetProviderModelName)
          : row.targetType === "access-point" && row.targetId
            ? this.postgresEnabledAccessPointPrice(row.targetId)
            : Promise.resolve(undefined),
      ]);
      return {
        id: row.id,
        scopeRef: row.scopeRef,
        name: row.name,
        description: row.description,
        targetType: row.targetType,
        targetId: row.targetId,
        targetProviderId: row.targetProviderId,
        targetProviderModelName: row.targetProviderModelName,
        status: row.status,
        targetAccessPointName: row.targetAccessPointName,
        enabledPrice: enabledPrice ?? null,
        targetCost: targetCost ?? null,
      };
    }));
    return { items, page, pageSize, total, totalPages, missingEnabledPriceCount: safePostgresInteger(summary?.missingEnabledPriceCount ?? 0, "postgres_access_point_workbench_missing_count_invalid") };
  }

  async pagePlanAccessPointPrices(
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePlanAccessPointPrices"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const totalRow = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "plan_access_point_prices"`, []);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_plan_access_point_price_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pagePlanAccessPointPrices"]>>["items"][number]>(
      `SELECT "id", "plan_id" AS "planId", "access_point_id" AS "accessPointId",
              "input_per_1m" AS "inputPer1M", "cached_input_per_1m" AS "cachedInputPer1M",
              "cache_write_per_1m" AS "cacheWritePer1M", "output_per_1m" AS "outputPer1M",
              "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "plan_access_point_prices"
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async listBudgetPolicies(): Promise<Awaited<ReturnType<ApplicationOperationPort["listBudgetPolicies"]>>> {
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listBudgetPolicies"]>>[number]>(
      `SELECT * FROM "budget_policies" ORDER BY "created_at" ASC, "id" ASC`,
    );
  }

  async createBudgetPolicy(input: Partial<BudgetPolicy> & { metric: string; limitValue: number; windowType: string }): Promise<BudgetPolicy> {
    const now = nowIso();
    const row: BudgetPolicy = {
      id: input.id ?? createId("budget"),
      metric: input.metric,
      limitValue: input.limitValue,
      windowType: input.windowType,
      windowSeconds: input.windowSeconds ?? null,
      status: postgresNormalizeToggleStatus(input.status ?? "enabled"),
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    postgresValidateBudgetPolicy(row);
    return this.insertRow<BudgetPolicy>("budget_policies", row);
  }

  async updateBudgetPolicy(id: string, input: Partial<Omit<BudgetPolicy, "id" | "createdAt" | "updatedAt">>): Promise<BudgetPolicy | undefined> {
    const existing = await this.one<BudgetPolicy>(`SELECT * FROM "budget_policies" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const next: BudgetPolicy = {
      ...existing,
      ...input,
      status: postgresNormalizeToggleStatus(input.status ?? existing.status),
      windowSeconds: input.windowSeconds === undefined ? existing.windowSeconds : input.windowSeconds,
      updatedAt: nowIso(),
    };
    postgresValidateBudgetPolicy(next);
    return this.updateRow<BudgetPolicy>("budget_policies", id, {
      metric: next.metric, limitValue: next.limitValue, windowType: next.windowType,
      windowSeconds: next.windowSeconds, status: next.status, updatedAt: next.updatedAt,
    });
  }

  async deleteBudgetPolicy(id: string): Promise<boolean> {
    const result = await this.query(`DELETE FROM "budget_policies" WHERE "id" = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createGovernanceBudgetPolicy(input: Partial<GovernanceBudgetPolicy> & { metric: string; limitValue: number; windowType: string }): Promise<GovernanceBudgetPolicy> {
    const now = nowIso();
    const row: GovernanceBudgetPolicy = {
      id: input.id ?? createId("governance_budget"),
      metric: input.metric,
      limitValue: input.limitValue,
      windowType: input.windowType,
      windowSeconds: input.windowSeconds ?? null,
      status: postgresNormalizeToggleStatus(input.status ?? "enabled"),
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    postgresValidateBudgetPolicy(row);
    return this.insertRow<GovernanceBudgetPolicy>("governance_budget_policies", row);
  }

  async updateGovernanceBudgetPolicy(id: string, input: Partial<Omit<GovernanceBudgetPolicy, "id" | "createdAt" | "updatedAt">>): Promise<GovernanceBudgetPolicy | undefined> {
    const existing = await this.one<GovernanceBudgetPolicy>(`SELECT * FROM "governance_budget_policies" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const next: GovernanceBudgetPolicy = {
      ...existing,
      ...input,
      status: postgresNormalizeToggleStatus(input.status ?? existing.status),
      windowSeconds: input.windowSeconds === undefined ? existing.windowSeconds : input.windowSeconds,
      updatedAt: nowIso(),
    };
    postgresValidateBudgetPolicy(next);
    return this.updateRow<GovernanceBudgetPolicy>("governance_budget_policies", id, {
      metric: next.metric, limitValue: next.limitValue, windowType: next.windowType,
      windowSeconds: next.windowSeconds, status: next.status, updatedAt: next.updatedAt,
    });
  }

  async deleteGovernanceBudgetPolicy(id: string): Promise<boolean> {
    const result = await this.query(`DELETE FROM "governance_budget_policies" WHERE "id" = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async assignBudgetPolicyToScope(input: { scopeRef: ScopeRef; budgetPolicyId: string; status?: string }): Promise<ScopeBudgetPolicy> {
    if (parseScopeRef(input.scopeRef).scopeType !== "key") throw new RelayError("scope_budget_policy_scope_not_supported", "Direct budget policies only support key scopes", 400);
    const policy = await this.one<BudgetPolicy>(`SELECT * FROM "budget_policies" WHERE "id" = $1`, [input.budgetPolicyId]);
    if (!policy) throw new RelayError("budget_policy_not_found", `Budget policy ${input.budgetPolicyId} not found`, 404);
    const now = nowIso();
    return this.insertRow<ScopeBudgetPolicy>("scope_budget_policies", {
      id: createId("scope_budget"), scopeRef: input.scopeRef, budgetPolicyId: input.budgetPolicyId,
      status: postgresNormalizeToggleStatus(input.status ?? "enabled"), createdAt: now, updatedAt: now,
    });
  }

  async updateScopeBudgetPolicyAssignment(id: string, input: Partial<Omit<ScopeBudgetPolicy, "id" | "createdAt" | "updatedAt">>): Promise<ScopeBudgetPolicy | undefined> {
    const existing = await this.one<ScopeBudgetPolicy>(`SELECT * FROM "scope_budget_policies" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const scopeRef = (input.scopeRef ?? existing.scopeRef) as ScopeRef;
    parseScopeRef(scopeRef);
    if (input.budgetPolicyId !== undefined && !(await this.one<{ id: string }>(`SELECT "id" FROM "budget_policies" WHERE "id" = $1`, [input.budgetPolicyId]))) {
      throw new RelayError("budget_policy_not_found", `Budget policy ${input.budgetPolicyId} not found`, 404);
    }
    return this.updateRow<ScopeBudgetPolicy>("scope_budget_policies", id, {
      scopeRef, budgetPolicyId: input.budgetPolicyId ?? existing.budgetPolicyId,
      status: postgresNormalizeToggleStatus(input.status ?? existing.status), updatedAt: nowIso(),
    });
  }

  async deleteScopeBudgetPolicyAssignment(id: string): Promise<boolean> {
    const result = await this.query(`DELETE FROM "scope_budget_policies" WHERE "id" = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async assignGovernanceBudgetPolicyToScope(input: { scopeRef: ScopeRef; governanceBudgetPolicyId: string; status?: string }): Promise<ScopeGovernanceBudgetPolicy> {
    const scopeType = parseScopeRef(input.scopeRef).scopeType;
    if (scopeType !== "global" && scopeType !== "team" && scopeType !== "user") throw new RelayError("governance_budget_scope_not_supported", "Governance budgets only support global, team, and user scopes", 400);
    if (!(await this.one<{ id: string }>(`SELECT "id" FROM "governance_budget_policies" WHERE "id" = $1`, [input.governanceBudgetPolicyId]))) throw new RelayError("governance_budget_policy_not_found", `Governance budget policy ${input.governanceBudgetPolicyId} not found`, 404);
    const now = nowIso();
    return this.insertRow<ScopeGovernanceBudgetPolicy>("scope_governance_budget_policies", {
      id: createId("scope_governance_budget"), scopeRef: input.scopeRef, governanceBudgetPolicyId: input.governanceBudgetPolicyId,
      status: postgresNormalizeToggleStatus(input.status ?? "enabled"), createdAt: now, updatedAt: now,
    });
  }

  async updateScopeGovernanceBudgetPolicyAssignment(id: string, input: Partial<Omit<ScopeGovernanceBudgetPolicy, "id" | "createdAt" | "updatedAt">>): Promise<ScopeGovernanceBudgetPolicy | undefined> {
    const existing = await this.one<ScopeGovernanceBudgetPolicy>(`SELECT * FROM "scope_governance_budget_policies" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const scopeRef = (input.scopeRef ?? existing.scopeRef) as ScopeRef;
    const scopeType = parseScopeRef(scopeRef).scopeType;
    if (scopeType !== "global" && scopeType !== "team" && scopeType !== "user") throw new RelayError("governance_budget_scope_not_supported", "Governance budgets only support global, team, and user scopes", 400);
    if (input.governanceBudgetPolicyId !== undefined && !(await this.one<{ id: string }>(`SELECT "id" FROM "governance_budget_policies" WHERE "id" = $1`, [input.governanceBudgetPolicyId]))) throw new RelayError("governance_budget_policy_not_found", `Governance budget policy ${input.governanceBudgetPolicyId} not found`, 404);
    return this.updateRow<ScopeGovernanceBudgetPolicy>("scope_governance_budget_policies", id, {
      scopeRef, governanceBudgetPolicyId: input.governanceBudgetPolicyId ?? existing.governanceBudgetPolicyId,
      status: postgresNormalizeToggleStatus(input.status ?? existing.status), updatedAt: nowIso(),
    });
  }

  async deleteScopeGovernanceBudgetPolicyAssignment(id: string): Promise<boolean> {
    const result = await this.query(`DELETE FROM "scope_governance_budget_policies" WHERE "id" = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    return this.one<Provider>(`SELECT * FROM "providers" WHERE "id" = $1`, [id]);
  }

  async getProviders(ids: readonly string[]): Promise<Provider[]> {
    const requested = [...new Set(ids)];
    if (requested.length === 0) return [];
    return this.rows<Provider>(`SELECT * FROM "providers" WHERE "id" = ANY($1::text[]) ORDER BY "id" ASC`, [requested]);
  }

  async getProviderBinding(providerId: string): Promise<ProviderBinding | undefined> {
    return this.one<ProviderBinding>(`SELECT * FROM "provider_bindings" WHERE "provider_id" = $1`, [providerId]);
  }

  async getProviderBindingRefreshSnapshots(providerIds: string[]): Promise<Array<{ provider: Provider; binding: ProviderBinding | null }>> {
    if (providerIds.length === 0) return [];
    const rows = await this.rows<Provider & {
      bindingAuthMethod: ProviderBinding["authMethod"] | null;
      bindingCredentialOwnership: ProviderBinding["credentialOwnership"] | null;
      bindingCredentialRefsJson: string | null;
      bindingCredentialPreview: string | null;
      bindingRevision: number | null;
      bindingSyncStatus: ProviderBinding["syncStatus"] | null;
      bindingErrorCode: string | null;
      bindingCreatedAt: string | null;
      bindingUpdatedAt: string | null;
    }>(
      `SELECT provider.*,
              binding."auth_method" AS "bindingAuthMethod",
              binding."credential_ownership" AS "bindingCredentialOwnership",
              binding."credential_refs_json" AS "bindingCredentialRefsJson",
              binding."credential_preview" AS "bindingCredentialPreview",
              binding."revision" AS "bindingRevision",
              binding."sync_status" AS "bindingSyncStatus",
              binding."error_code" AS "bindingErrorCode",
              binding."created_at" AS "bindingCreatedAt",
              binding."updated_at" AS "bindingUpdatedAt"
       FROM "providers" provider
       LEFT JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
       WHERE provider."id" = ANY($1::text[])
       ORDER BY provider."id"`,
      [providerIds],
    );
    return rows.map((row) => ({
      provider: {
        id: row.id, ownerId: row.ownerId, scopeRef: row.scopeRef, name: row.name, kind: row.kind, status: row.status,
        baseUrlResolver: row.baseUrlResolver, credentialResolver: row.credentialResolver, modelsResolver: row.modelsResolver,
        configJson: row.configJson, cpaInstanceId: row.cpaInstanceId, createdAt: row.createdAt, updatedAt: row.updatedAt,
      },
      binding: row.bindingAuthMethod === null || row.bindingCredentialOwnership === null || row.bindingCredentialRefsJson === null
        || row.bindingRevision === null || row.bindingSyncStatus === null || row.bindingCreatedAt === null || row.bindingUpdatedAt === null
        ? null
        : {
            providerId: row.id, authMethod: row.bindingAuthMethod, credentialOwnership: row.bindingCredentialOwnership,
            credentialRefsJson: row.bindingCredentialRefsJson, credentialPreview: row.bindingCredentialPreview,
            revision: row.bindingRevision, syncStatus: row.bindingSyncStatus, errorCode: row.bindingErrorCode,
            createdAt: row.bindingCreatedAt, updatedAt: row.bindingUpdatedAt,
          },
    }));
  }

  async upsertProviderBinding(input: Parameters<ApplicationOperationPort["upsertProviderBinding"]>[0]): Promise<ProviderBinding> {
    return this.withRetriedTransaction(async (transaction) => {
      const row = await transaction.providerBindingRow(input);
      return transaction.upsertRow<ProviderBinding>("provider_bindings", row, ["providerId"], [
        "authMethod", "credentialOwnership", "credentialRefsJson", "credentialPreview", "revision", "syncStatus", "errorCode", "updatedAt",
      ]);
    });
  }

  async updateProviderBindingStatusIfCurrent(input: {
    providerId: string;
    expectedCpaInstanceId: string;
    expectedRevision: number;
    syncStatus: ProviderBinding["syncStatus"];
    errorCode?: string | null;
    clearCredentialSummary?: boolean;
  }): Promise<ProviderBinding | undefined> {
    const result = await this.query<ProviderBinding>(
      `UPDATE "provider_bindings" binding
       SET "credential_refs_json" = CASE WHEN $7 THEN '[]' ELSE "credential_refs_json" END,
           "credential_preview" = CASE WHEN $7 THEN NULL ELSE "credential_preview" END,
           "sync_status" = $4,
           "error_code" = CASE WHEN $4 = 'error' THEN COALESCE($5, 'cliproxy_binding_error') ELSE NULL END,
           "updated_at" = $6
       FROM "providers" provider
       WHERE binding."provider_id" = $1
         AND provider."id" = binding."provider_id"
         AND provider."cpa_instance_id" = $2
         AND binding."revision" = $3
       RETURNING binding.*`,
      [input.providerId, input.expectedCpaInstanceId, input.expectedRevision, input.syncStatus, input.errorCode ?? null, nowIso(), input.clearCredentialSummary === true],
    );
    const row = result.rows[0];
    return row ? mapPostgresRow<ProviderBinding>(row) : undefined;
  }

  async getTeamProviderEntitlementState(teamId: string, at = nowIso()): Promise<TeamProviderEntitlementState> {
    const rows = await this.rows<TeamProviderEntitlement>(
      `SELECT * FROM "team_provider_entitlements"
       WHERE "team_id" = $1
       ORDER BY "effective_start" ASC, "id" ASC`,
      [teamId],
    );
    if (rows.length === 0) return { state: "not_entitled", entitlement: null, nextEntitlement: null, latestEffectiveEnd: null };
    const eligible = rows.filter((row) => row.lifecycle === "active");
    const current = eligible.find((row) => row.effectiveStart <= at && (row.effectiveEnd === null || at < row.effectiveEnd));
    const nextEntitlement = eligible.find((row) => row.effectiveStart > at) ?? null;
    const latestEffectiveEnd = rows.reduce<string | null>((latest, row) => row.effectiveEnd !== null && (latest === null || row.effectiveEnd > latest) ? row.effectiveEnd : latest, null);
    if (current) return { state: current.effectiveEnd === null ? "permanent" : "active", entitlement: current, nextEntitlement, latestEffectiveEnd };
    if (nextEntitlement) return { state: "scheduled", entitlement: null, nextEntitlement, latestEffectiveEnd };
    return { state: "expired", entitlement: null, nextEntitlement: null, latestEffectiveEnd };
  }

  async getPartnerOperatingState(partnerTeamId: string, at = nowIso()): Promise<PartnerOperatingState> {
    const rows = await this.rows<PartnerOperatingEntitlement & { subscriptionActive: boolean }>(
      `SELECT entitlement.*,
              EXISTS (
                SELECT 1 FROM "plan_subscriptions" subscription
                WHERE subscription."id" = entitlement."plan_subscription_id"
                  AND subscription."plan_id" = entitlement."partner_plan_id"
                  AND subscription."scope_ref" = 'team:' || entitlement."partner_team_id"
                  AND subscription."subscription_lifecycle" = 'active'
                  AND subscription."effective_start" <= $2
                  AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)
              ) AS "subscription_active"
       FROM "partner_operating_entitlements" entitlement
       WHERE entitlement."partner_team_id" = $1
       ORDER BY entitlement."effective_end" DESC, entitlement."created_at" DESC`,
      [partnerTeamId, at],
    );
    if (rows.length === 0) return { kind: "not_partner" };
    const active = rows.find((row) => row.lifecycle === "active" && row.effectiveStart <= at && row.effectiveEnd > at && row.subscriptionActive);
    if (!active) return { kind: "inactive", latestEffectiveEnd: rows[0]?.effectiveEnd ?? null };
    const { subscriptionActive: _subscriptionActive, ...entitlement } = active;
    return { kind: "active", entitlement };
  }

  async assertPartnerManagementActive(partnerTeamId: string, at = nowIso()): Promise<void> {
    const state = await this.getPartnerOperatingState(partnerTeamId, at);
    if (state.kind === "inactive") throw new RelayError("partner_entitlement_expired", "Partner management entitlement has expired. Renew on the main platform to continue managing this service.", 403);
  }

  async createProvider(input: Partial<Provider> & { id: string; name: string; kind: string; baseUrlResolver: string; credentialResolver: string; modelsResolver: string; ownerId?: string; scopeRef?: string }): Promise<Provider> {
    const now = nowIso();
    const ownerId = input.ownerId ?? (() => { throw new Error("postgres_provider_owner_required"); })();
    const cpaInstanceId = input.cpaInstanceId ?? DEFAULT_CPA_INSTANCE_ID;
    await this.assertProviderCpaAssignment(cpaInstanceId);
    const row: Provider = {
      id: input.id,
      ownerId,
      scopeRef: input.scopeRef ?? `user:${ownerId}`,
      name: input.name,
      kind: input.kind,
      status: input.status ?? "enabled",
      baseUrlResolver: input.baseUrlResolver,
      credentialResolver: input.credentialResolver,
      modelsResolver: input.modelsResolver,
      configJson: input.configJson ?? "{}",
      cpaInstanceId,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    return this.insertRow<Provider>("providers", row);
  }

  async upsertProvider(input: Partial<Provider> & { id: string; name: string; kind: string; baseUrlResolver: string; credentialResolver: string; modelsResolver: string; ownerId?: string; scopeRef?: string }): Promise<Provider> {
    const existing = await this.getProvider(input.id);
    const now = nowIso();
    const ownerId = input.ownerId ?? existing?.ownerId ?? (() => { throw new Error("postgres_provider_owner_required"); })();
    const cpaInstanceId = input.cpaInstanceId ?? existing?.cpaInstanceId ?? DEFAULT_CPA_INSTANCE_ID;
    await this.assertProviderCpaAssignment(cpaInstanceId, existing);
    const row: Provider = {
      id: input.id,
      ownerId,
      scopeRef: input.scopeRef ?? existing?.scopeRef ?? `user:${ownerId}`,
      name: input.name,
      kind: input.kind,
      status: input.status ?? existing?.status ?? "enabled",
      baseUrlResolver: input.baseUrlResolver,
      credentialResolver: input.credentialResolver,
      modelsResolver: input.modelsResolver,
      configJson: input.configJson ?? existing?.configJson ?? "{}",
      cpaInstanceId,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.upsertRow<Provider>("providers", row, ["id"], [
      "ownerId", "scopeRef", "name", "kind", "status", "baseUrlResolver", "credentialResolver", "modelsResolver", "configJson", "cpaInstanceId", "updatedAt",
    ]);
  }

  async listCpaInstances(): Promise<CpaInstance[]> {
    return this.rows<CpaInstance>(`SELECT * FROM "cpa_instances" ORDER BY "id" ASC`);
  }

  async getCpaInstance(id: string): Promise<CpaInstance | undefined> {
    return this.one<CpaInstance>(`SELECT * FROM "cpa_instances" WHERE "id" = $1`, [id]);
  }

  async createCpaInstance(input: { id: string; name: string; status?: "enabled" | "disabled" }): Promise<CpaInstance> {
    assertCpaInstanceId(input.id);
    const name = input.name.trim();
    if (!name) throw new RelayError("cpa_instance_name_invalid", "CPA Instance name is required", 400);
    const now = nowIso();
    const row: CpaInstance = { id: input.id, name, status: input.status ?? "enabled", createdAt: now, updatedAt: now };
    return this.insertRow<CpaInstance>("cpa_instances", row);
  }

  async updateCpaInstanceStatus(id: string, status: "enabled" | "disabled"): Promise<CpaInstance | undefined> {
    const existing = await this.getCpaInstance(id);
    if (!existing) return undefined;
    return this.upsertRow<CpaInstance>("cpa_instances", { ...existing, status, updatedAt: nowIso() }, ["id"], ["status", "updatedAt"]);
  }

  private async assertProviderCpaAssignment(cpaInstanceId: string, existing?: Provider): Promise<void> {
    assertCpaInstanceId(cpaInstanceId);
    const cpa = await this.getCpaInstance(cpaInstanceId);
    if (!cpa) throw new RelayError("cpa_instance_not_found", "CPA Instance is not registered", 409);
    if (existing && existing.cpaInstanceId !== cpaInstanceId) {
      const binding = await this.getProviderBinding(existing.id);
      if (binding && binding.syncStatus !== "cleared") throw new RelayError("cpa_instance_immutable", "Provider CPA Instance cannot change after credential lifecycle starts", 409);
    }
    if (cpa.status !== "enabled" && (!existing || existing.cpaInstanceId !== cpaInstanceId)) {
      throw new RelayError("cpa_instance_disabled", "CPA Instance is disabled", 409);
    }
  }

  async listProviderModels(): Promise<ProviderModel[]> {
    return this.rows<ProviderModel>(`SELECT * FROM "provider_models" ORDER BY "provider_id" ASC, "provider_model_name" ASC`);
  }

  async getProviderModel(providerId: string, providerModelName: string): Promise<ProviderModel | undefined> {
    return this.one<ProviderModel>(`SELECT * FROM "provider_models" WHERE "provider_id" = $1 AND "provider_model_name" = $2`, [providerId, providerModelName]);
  }

  async upsertProviderModel(input: Partial<ProviderModel> & { providerId: string; providerModelName: string; displayName?: string }): Promise<ProviderModel> {
    const now = nowIso();
    const row: ProviderModel = {
      id: input.id ?? createId("provider_model"),
      providerId: input.providerId,
      providerModelName: input.providerModelName,
      displayName: input.displayName ?? input.providerModelName,
      status: input.status ?? "enabled",
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    return this.upsertRow<ProviderModel>("provider_models", row, ["id"], ["providerId", "providerModelName", "displayName", "status", "updatedAt"]);
  }

  async getProviderDeletionState(id: string): Promise<{ providerId: string; hasAccessPointReferences: boolean; hasOnlineBillingHistory: boolean; credentialCleared: boolean; retained: boolean } | null> {
    const row = await this.one<{ providerId: string; hasAccessPointReferences: boolean; hasOnlineBillingHistory: boolean; credentialCleared: boolean; providerStatus: string }>(
      `SELECT provider."id" AS "providerId",
              EXISTS (SELECT 1 FROM "access_point_targets" target WHERE target."target_type" = 'provider-model' AND target."target_provider_id" = provider."id") AS "hasAccessPointReferences",
              EXISTS (SELECT 1 FROM "billing_provider_cost_events" event WHERE event."provider_id" = provider."id") AS "hasOnlineBillingHistory",
              (NOT EXISTS (SELECT 1 FROM "provider_bindings" binding WHERE binding."provider_id" = provider."id") OR EXISTS (SELECT 1 FROM "provider_bindings" binding WHERE binding."provider_id" = provider."id" AND binding."credential_refs_json" = '[]' AND binding."credential_preview" IS NULL AND binding."error_code" IS NULL AND binding."sync_status" = 'cleared')) AS "credentialCleared",
              provider."status" AS "providerStatus"
       FROM "providers" provider WHERE provider."id" = $1`,
      [id],
    );
    if (!row) return null;
    return { providerId: row.providerId, hasAccessPointReferences: Boolean(row.hasAccessPointReferences), hasOnlineBillingHistory: Boolean(row.hasOnlineBillingHistory), credentialCleared: Boolean(row.credentialCleared), retained: row.providerStatus === "disabled" && Boolean(row.hasOnlineBillingHistory) };
  }

  async deleteProvider(id: string): Promise<boolean> {
    return this.withRetriedTransaction(async (transaction) => {
      const state = await transaction.getProviderDeletionState(id);
      if (!state) throw new RelayError("provider_not_found", `Provider ${id} not found`, 404);
      if (state.hasOnlineBillingHistory) throw new RelayError("provider_history_retained", `Provider ${id} is retained by online billing history`, 409);
      if (state.hasAccessPointReferences) throw new RelayError("provider_in_use", `Provider ${id} is used by an AccessPoint`, 409);
      const provider = await transaction.getProvider(id);
      if (!provider) throw new RelayError("provider_not_found", `Provider ${id} not found`, 404);
      if (provider.status !== "disabled") throw new RelayError("provider_must_be_disabled", `Provider ${id} must be disabled before deletion`, 409);
      if (!state.credentialCleared) throw new RelayError("provider_credential_not_cleared", `Provider ${id} credential must be cleared before deletion`, 409);
      await transaction.query(`DELETE FROM "provider_models" WHERE "provider_id" = $1`, [id]);
      await transaction.query(`DELETE FROM "provider_bindings" WHERE "provider_id" = $1`, [id]);
      const result = await transaction.query(`DELETE FROM "providers" WHERE "id" = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async listAccessPoints(): Promise<AccessPoint[]> {
    return this.rows<AccessPoint>(`SELECT * FROM "access_points" WHERE "removed_at" IS NULL ORDER BY "priority" ASC, "created_at" ASC, "id" ASC`);
  }

  async getAccessPoint(id: string): Promise<AccessPoint | undefined> {
    return this.one<AccessPoint>(`SELECT * FROM "access_points" WHERE "id" = $1 AND "removed_at" IS NULL`, [id]);
  }

  async getAccessPoints(ids: readonly string[]): Promise<AccessPoint[]> {
    const requested = [...new Set(ids)];
    if (requested.length === 0) return [];
    return this.rows<AccessPoint>(
      `SELECT * FROM "access_points" WHERE "id" = ANY($1::text[]) AND "removed_at" IS NULL ORDER BY "id" ASC`,
      [requested],
    );
  }

  async createAccessPoint(input: {
    ownerId: string;
    scopeRef: ScopeRef;
    name: string;
    description?: string | null;
    apiFamily: string;
    exposedModel: string;
    targetModel: string;
    targetType: AccessPointTargetType;
    targetId?: string | null;
    targetProviderId?: string | null;
    targetProviderModelName?: string | null;
    salePrice?: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number } | null;
    priority?: number;
    weight?: number;
    fallbackOrder?: number;
    status?: string;
  }): Promise<AccessPoint> {
    return this.withRetriedTransaction(async (transaction) => {
      const now = nowIso();
      const targetModel = postgresRequiredTrimmed(input.targetModel, "targetModel");
      const exposedModel = postgresRequiredTrimmed(input.exposedModel, "exposedModel");
      let defaultPrice: AccessPointPrice | ProviderModelCost | undefined;
      if (input.targetType === "provider-model") {
        const providerId = postgresRequiredTrimmed(input.targetProviderId, "targetProviderId");
        const providerModelName = postgresRequiredTrimmed(input.targetProviderModelName ?? targetModel, "targetProviderModelName");
        if (providerModelName !== targetModel) throw new RelayError("access_point_target_model_mismatch", "targetProviderModelName must equal targetModel", 400);
        const provider = await transaction.getProvider(providerId);
        if (!provider || provider.scopeRef !== input.scopeRef || provider.status !== "enabled") throw new RelayError("invalid_access_point", `Unknown Provider: ${providerId}`, 400);
        const providerModel = await transaction.getProviderModel(providerId, providerModelName);
        if (!providerModel || providerModel.status !== "enabled") throw new RelayError("provider_model_not_found", `Provider model ${providerId}:${providerModelName} not found or disabled`, 404);
        defaultPrice = await transaction.findEnabledProviderModelCost(providerId, providerModelName);
        if (!defaultPrice) throw new RelayError("provider_model_cost_not_configured", `Provider model ${providerId}:${providerModelName} has no enabled cost`, 500);
      } else {
        const targetId = postgresRequiredTrimmed(input.targetId, "targetId");
        const target = await transaction.getAccessPoint(targetId);
        if (!target || target.status !== "enabled" || target.exposedModel !== targetModel) throw new RelayError("invalid_access_point", `Unknown AccessPoint: ${targetId}`, 400);
        const memberships = await transaction.listAvailableTeamMemberships(input.ownerId);
        const visibleScopes = new Set(["global:", input.scopeRef, ...memberships.map((membership) => `team:${membership.teamId}`)]);
        if (!visibleScopes.has(target.scopeRef)) throw new RelayError("access_point_source_not_authorized", `Target AccessPoint ${target.id} is not authorized for scope ${input.scopeRef}`, 403);
        defaultPrice = await transaction.findEnabledAccessPointPrice(target.id);
        if (!defaultPrice) throw new RelayError("access_point_price_not_configured", `Target AccessPoint ${target.id} has no enabled salePrice`, 500);
      }
      const price = input.salePrice ?? defaultPrice;
      if (!price) throw new RelayError("access_point_price_not_configured", "AccessPoint salePrice is not configured", 500);
      postgresValidatePrice(price);
      const row: AccessPoint = {
        id: createId("ap"), ownerId: input.ownerId, scopeRef: input.scopeRef, name: input.name,
        description: normalizeAccessPointDescription(input.description),
        apiFamily: input.apiFamily, exposedModel, targetModel, selectorId: "direct", selectorBehaviorVersion: 1,
        selectorConfigJson: "{}", requestOverridesJson: "{}", routingRevision: 1,
        targetType: input.targetType, targetId: input.targetType === "access-point" ? postgresRequiredTrimmed(input.targetId, "targetId") : null,
        targetProviderId: input.targetType === "provider-model" ? postgresRequiredTrimmed(input.targetProviderId, "targetProviderId") : null,
        targetProviderModelName: input.targetType === "provider-model" ? postgresRequiredTrimmed(input.targetProviderModelName ?? targetModel, "targetProviderModelName") : null,
        priority: input.priority ?? 100, weight: input.weight ?? 1, fallbackOrder: input.fallbackOrder ?? 100,
        status: input.status ?? "enabled", createdAt: now, updatedAt: now,
      };
      await transaction.insertRow<AccessPoint>("access_points", row);
      await transaction.insertRow<AccessPointTarget>("access_point_targets", {
        id: createId("ap_target"), accessPointId: row.id, targetType: row.targetType,
        targetAccessPointId: row.targetType === "access-point" ? row.targetId : null,
        targetProviderId: row.targetType === "provider-model" ? row.targetProviderId : null,
        targetProviderModelName: row.targetType === "provider-model" ? row.targetProviderModelName : null,
        position: 0, status: "enabled", createdAt: now, updatedAt: now,
      });
      await transaction.insertRow<AccessPointPrice>("access_point_prices", {
        id: createId("access_price"), accessPointId: row.id, inputPer1M: price.inputPer1M,
        cachedInputPer1M: price.cachedInputPer1M, cacheWritePer1M: price.cacheWritePer1M === undefined ? price.inputPer1M : price.cacheWritePer1M,
        outputPer1M: price.outputPer1M, status: "enabled", createdAt: now, updatedAt: now,
      });
      return row;
    });
  }

  async createAccessPointAdmin(input: {
    ownerId: string;
    scopeRef: ScopeRef;
    name: string;
    description?: string | null;
    apiFamily: string;
    exposedModel: string;
    targetModel: string;
    targetType?: AccessPointTargetType;
    targetId?: string | null;
    targetProviderId?: string | null;
    targetProviderModelName?: string | null;
    routing?: { selector: { id: AccessPointSelectorId; behaviorVersion: 1; config?: unknown }; requestOverrides?: unknown; targets: Array<{ id?: string; type: AccessPointTargetType; targetAccessPointId?: string | null; targetProviderId?: string | null; targetProviderModelName?: string | null; position: number; status?: "enabled" | "disabled" }> };
    salePrice?: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number; tiers?: PriceTierInput[] } | null;
    priority?: number;
    weight?: number;
    fallbackOrder?: number;
    status?: string;
  }): Promise<AccessPoint> {
    return this.withRetriedTransaction(async (transaction) => {
      const now = nowIso();
      const targetModel = postgresRequiredTrimmed(input.targetModel, "targetModel");
      const exposedModel = postgresRequiredTrimmed(input.exposedModel, "exposedModel");
      const targets: Array<{ id?: string; type: AccessPointTargetType; targetAccessPointId?: string | null; targetProviderId?: string | null; targetProviderModelName?: string | null; position: number; status?: "enabled" | "disabled" }> = input.routing?.targets?.length
        ? [...input.routing.targets].sort((left, right) => left.position - right.position || String(left.id ?? "").localeCompare(String(right.id ?? "")))
        : [{ type: (input.targetType ?? "provider-model") as AccessPointTargetType, targetAccessPointId: input.targetId ?? null, targetProviderId: input.targetProviderId ?? null, targetProviderModelName: input.targetProviderModelName ?? targetModel, position: 0, status: "enabled" as const }];
      const primary = targets.find((target) => target.status !== "disabled") ?? targets[0];
      if (!primary) throw new RelayError("invalid_access_point_routing", "AccessPoint requires at least one target", 400);
      const primaryType = primary.type;
      let targetCost: AccessPointPrice | ProviderModelCost | undefined;
      if (primaryType === "provider-model") {
        const providerId = postgresRequiredTrimmed(primary.targetProviderId, "targetProviderId");
        const providerModelName = postgresRequiredTrimmed(primary.targetProviderModelName ?? targetModel, "targetProviderModelName");
        const provider = await transaction.getProvider(providerId);
        const model = await transaction.getProviderModel(providerId, providerModelName);
        if (!provider || provider.status !== "enabled") throw new RelayError("invalid_access_point", `Unknown Provider: ${providerId}`, 400);
        if (!model || model.status !== "enabled") throw new RelayError("provider_model_not_found", `Provider model ${providerId}:${providerModelName} not found or disabled`, 404);
        targetCost = await transaction.findEnabledProviderModelCost(providerId, providerModelName);
      } else {
        const targetId = postgresRequiredTrimmed(primary.targetAccessPointId, "targetAccessPointId");
        const target = await transaction.getAccessPoint(targetId);
        if (!target || target.status !== "enabled") throw new RelayError("invalid_access_point", `Unknown AccessPoint: ${targetId}`, 400);
        targetCost = await transaction.findEnabledAccessPointPrice(targetId);
      }
      const price = input.salePrice ?? targetCost;
      if (!price) throw new RelayError("access_point_price_not_configured", "AccessPoint salePrice is not configured", 500);
      postgresValidatePrice(price);
      const requestOverrides = postgresNormalizeAccessPointRequestOverrides(input.routing?.requestOverrides ?? {});
      const row: AccessPoint = {
        id: createId("ap"), ownerId: input.ownerId, scopeRef: input.scopeRef, name: input.name,
        description: normalizeAccessPointDescription(input.description), apiFamily: input.apiFamily,
        exposedModel, targetModel, selectorId: input.routing?.selector.id ?? "direct", selectorBehaviorVersion: input.routing?.selector.behaviorVersion ?? 1,
        selectorConfigJson: JSON.stringify(input.routing?.selector.config ?? {}), requestOverridesJson: JSON.stringify(requestOverrides), routingRevision: 1,
        ...postgresAccessPointTargetProjection(primary, targetModel),
        priority: input.priority ?? 100, weight: input.weight ?? 1, fallbackOrder: input.fallbackOrder ?? 100,
        status: input.status ?? "disabled", createdAt: now, updatedAt: now,
      };
      await transaction.insertRow<AccessPoint>("access_points", row);
      for (const target of targets) {
        await transaction.insertRow<AccessPointTarget>("access_point_targets", {
          id: target.id ?? createId("ap_target"), accessPointId: row.id, targetType: target.type,
          targetAccessPointId: target.targetAccessPointId ?? null, targetProviderId: target.targetProviderId ?? null,
          targetProviderModelName: target.targetProviderModelName ?? null, position: target.position,
          status: target.status ?? "enabled", createdAt: now, updatedAt: now,
        });
      }
      const createdPrice = await transaction.insertRow<AccessPointPrice>("access_point_prices", {
        id: createId("access_price"), accessPointId: row.id, inputPer1M: price.inputPer1M, cachedInputPer1M: price.cachedInputPer1M,
        cacheWritePer1M: price.cacheWritePer1M === undefined ? price.inputPer1M : price.cacheWritePer1M,
        outputPer1M: price.outputPer1M, status: "enabled", createdAt: now, updatedAt: now,
      });
      await transaction.insertPostgresPriceTiers("access_point_price_tiers", "accessPointPriceId", createdPrice.id, postgresNormalizePriceTiers(price.tiers ?? [], "access_point_price_tier"), "access_price_tier");
      return row;
    });
  }

  async updateAccessPointAdmin(id: string, input: Parameters<ApplicationOperationPort["updateAccessPoint"]>[1]): Promise<AccessPoint | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getAccessPoint(id);
      if (!existing) return undefined;
      const routing = input.routing;
      if (!routing && existing.selectorId !== "direct") throw new RelayError("access_point_routing_payload_required", "Ordered AccessPoint updates require the routing payload", 409);
      if (routing?.expectedRoutingRevision !== undefined && routing.expectedRoutingRevision !== existing.routingRevision) throw new RelayError("access_point_routing_revision_conflict", "AccessPoint routing revision does not match", 409, { routingRevision: existing.routingRevision });
      const targetModel = postgresRequiredTrimmed(input.targetModel, "targetModel");
      const targets: Array<{ id?: string; type: AccessPointTargetType; targetAccessPointId?: string | null; targetProviderId?: string | null; targetProviderModelName?: string | null; position: number; status?: "enabled" | "disabled" }> = routing?.targets?.length
        ? [...routing.targets].sort((left, right) => left.position - right.position || String(left.id ?? "").localeCompare(String(right.id ?? "")))
        : [{ type: (input.targetType ?? existing.targetType) as AccessPointTargetType, targetAccessPointId: input.targetId ?? existing.targetId, targetProviderId: input.targetProviderId ?? existing.targetProviderId, targetProviderModelName: input.targetProviderModelName ?? existing.targetProviderModelName, position: 0, status: "enabled" as const }];
      const primary = targets.find((target) => target.status !== "disabled") ?? targets[0];
      if (!primary) throw new RelayError("invalid_access_point_routing", "AccessPoint requires at least one target", 400);
      const requestOverrides = postgresNormalizeAccessPointRequestOverrides(routing?.requestOverrides ?? parseAccessPointRequestOverridesJson(existing.requestOverridesJson));
      const next: AccessPoint = {
        ...existing, ownerId: input.ownerId ?? existing.ownerId, scopeRef: (input.scopeRef ?? existing.scopeRef) as ScopeRef,
        name: input.name,
        description: input.description === undefined ? existing.description : normalizeAccessPointDescription(input.description),
        apiFamily: input.apiFamily, exposedModel: postgresRequiredTrimmed(input.exposedModel, "exposedModel"), targetModel,
        selectorId: routing?.selector.id ?? "direct", selectorBehaviorVersion: routing?.selector.behaviorVersion ?? 1,
        selectorConfigJson: JSON.stringify(routing?.selector.config ?? {}), requestOverridesJson: JSON.stringify(requestOverrides), routingRevision: existing.routingRevision + (routing ? 1 : 0),
        ...postgresAccessPointTargetProjection(primary, targetModel), priority: input.priority ?? existing.priority,
        weight: input.weight ?? existing.weight, fallbackOrder: input.fallbackOrder ?? existing.fallbackOrder,
        status: input.status ?? existing.status, updatedAt: nowIso(),
      };
      await transaction.updateRow<AccessPoint>("access_points", id, next);
      if (routing) {
        await transaction.query(`DELETE FROM "access_point_targets" WHERE "access_point_id" = $1`, [id]);
        for (const target of targets) await transaction.insertRow<AccessPointTarget>("access_point_targets", {
          id: target.id ?? createId("ap_target"), accessPointId: id, targetType: target.type,
          targetAccessPointId: target.targetAccessPointId ?? null, targetProviderId: target.targetProviderId ?? null,
          targetProviderModelName: target.targetProviderModelName ?? null, position: target.position,
          status: target.status ?? "enabled", createdAt: next.updatedAt, updatedAt: next.updatedAt,
        });
      }
      return next;
    });
  }

  async deleteAccessPoint(id: string): Promise<boolean> {
    return this.withRetriedTransaction(async (transaction) => {
      await transaction.query(`DELETE FROM "access_point_targets" WHERE "access_point_id" = $1`, [id]);
      const result = await transaction.query(`DELETE FROM "access_points" WHERE "id" = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async getAccessPointWithRouting(id: string): Promise<AccessPointWithRouting | undefined> {
    return new ModelAccessManagementQueryService(this.client).getAccessPointWithRouting(id);
  }

  async accessPointPlanImpact(
    accessPointId: string,
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["accessPointPlanImpact"]>>> {
    const [plans, subscriptionCount, accessPoint] = await Promise.all([
      this.rows<Awaited<ReturnType<ApplicationOperationPort["accessPointPlanImpact"]>>["plans"][number]>(
        `SELECT plan."id", plan."name", plan."version"
         FROM "plans" plan
         INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
         WHERE relation."access_point_id" = $1
         ORDER BY plan."name" ASC, plan."version" ASC, plan."id" ASC`,
        [accessPointId],
      ),
      this.one<{ count: number }>(
        `SELECT COUNT(*)::int AS "count"
         FROM "plan_subscriptions" subscription
         INNER JOIN "plan_access_points" relation ON relation."plan_id" = subscription."plan_id"
         WHERE relation."access_point_id" = $1
           AND subscription."subscription_lifecycle" = 'active'
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)`,
        [accessPointId, at],
      ),
      this.getAccessPoint(accessPointId),
    ]);
    return {
      plans,
      activeOrFutureSubscriptionCount: safePostgresInteger(subscriptionCount?.count ?? 0, "postgres_access_point_subscription_count_invalid"),
      exposedModels: accessPoint ? [accessPoint.exposedModel] : [],
    };
  }

  async listAccessPointTargets(accessPointId: string, includeDisabled = true): Promise<AccessPointTarget[]> {
    return this.rows<AccessPointTarget>(
      `SELECT * FROM "access_point_targets"
       WHERE "access_point_id" = $1 AND "removed_at" IS NULL${includeDisabled ? "" : " AND \"status\" = 'enabled'"}
       ORDER BY "position" ASC, "id" ASC`,
      [accessPointId],
    );
  }

  async listAccessPointTargetsByIds(accessPointIds: readonly string[], includeDisabled = true): Promise<AccessPointTarget[]> {
    const requested = [...new Set(accessPointIds)];
    if (requested.length === 0) return [];
    return this.rows<AccessPointTarget>(
      `SELECT * FROM "access_point_targets"
       WHERE "access_point_id" = ANY($1::text[]) AND "removed_at" IS NULL${includeDisabled ? "" : " AND \"status\" = 'enabled'"}
       ORDER BY "access_point_id" ASC, "position" ASC, "id" ASC`,
      [requested],
    );
  }

  async listAccessPointsVisibleAtScope(scopeRef: string): Promise<AccessPoint[]> {
    return this.rows<AccessPoint>(
      `SELECT * FROM "access_points"
       WHERE "scope_ref" = $1 AND "status" = 'enabled' AND "removed_at" IS NULL
       ORDER BY "priority" ASC, "fallback_order" ASC, "created_at" ASC, "id" ASC`,
      [scopeRef],
    );
  }

  async findEnabledProviderModelCost(providerId: string, providerModelName: string): Promise<ProviderModelCost | undefined> {
    const cost = await this.one<ProviderModelCost>(
      `SELECT * FROM "provider_model_costs"
       WHERE "provider_id" = $1 AND "provider_model_name" = $2 AND "status" = 'enabled'
       ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
      [providerId, providerModelName],
    );
    return cost ? { ...cost, tiers: await this.listProviderModelCostTiers(cost.id) } : undefined;
  }

  async findEnabledProviderModelCosts(input: readonly { providerId: string; providerModelName: string }[]): Promise<ProviderModelCost[]> {
    const requested = [...new Map(input.map((item) => [`${item.providerId}\u0000${item.providerModelName}`, item])).values()];
    if (requested.length === 0) return [];
    const costs = await this.rows<ProviderModelCost>(
      `WITH requested AS (
         SELECT "providerId", "providerModelName"
         FROM jsonb_to_recordset($1::jsonb) AS request("providerId" text, "providerModelName" text)
       )
       SELECT cost.*
       FROM requested
       CROSS JOIN LATERAL (
         SELECT candidate.*
         FROM "provider_model_costs" candidate
         WHERE candidate."provider_id" = requested."providerId"
           AND candidate."provider_model_name" = requested."providerModelName"
           AND candidate."status" = 'enabled'
         ORDER BY candidate."created_at" DESC, candidate."id" DESC
         LIMIT 1
       ) cost
       ORDER BY cost."provider_id" ASC, cost."provider_model_name" ASC`,
      [JSON.stringify(requested)],
    );
    if (costs.length === 0) return [];
    const tiers = await this.rows<ProviderModelCostTier>(
      `SELECT * FROM "provider_model_cost_tiers"
       WHERE "provider_model_cost_id" = ANY($1::text[])
       ORDER BY "provider_model_cost_id" ASC, "min_input_tokens" ASC, "tier_key" ASC`,
      [costs.map((cost) => cost.id)],
    );
    const tiersByCostId = new Map<string, ProviderModelCostTier[]>();
    for (const tier of tiers) {
      const costTiers = tiersByCostId.get(tier.providerModelCostId) ?? [];
      costTiers.push(tier);
      tiersByCostId.set(tier.providerModelCostId, costTiers);
    }
    return costs.map((cost) => ({ ...cost, tiers: tiersByCostId.get(cost.id) ?? [] }));
  }

  async createProviderModelCost(input: {
    providerId: string;
    providerModelName: string;
    inputPer1M: number;
    cachedInputPer1M: number;
    cacheWritePer1M?: number | null;
    outputPer1M: number;
    source?: string;
    status?: string;
    tiers?: PriceTierInput[];
  }): Promise<ProviderModelCost> {
    const normalizedInput = {
      ...input,
      cacheWritePer1M: input.cacheWritePer1M === undefined ? input.inputPer1M : input.cacheWritePer1M,
    };
    postgresValidatePrice(normalizedInput);
    const provider = await this.getProvider(input.providerId);
    const model = await this.getProviderModel(input.providerId, input.providerModelName);
    if (!provider || !model) throw new RelayError("provider_model_not_found", `Provider model ${input.providerId}:${input.providerModelName} not found`, 404);
    const now = nowIso();
    const tiers = postgresNormalizePriceTiers(input.tiers ?? [], "provider_model_cost_tier");
    return this.withRetriedTransaction(async (transaction) => {
      const row = await transaction.insertRow<ProviderModelCost>("provider_model_costs", {
        id: createId("provider_cost"), providerId: input.providerId, providerModelName: input.providerModelName,
        inputPer1M: input.inputPer1M, cachedInputPer1M: input.cachedInputPer1M,
        cacheWritePer1M: normalizedInput.cacheWritePer1M,
        outputPer1M: input.outputPer1M, source: input.source ?? "fixed", status: input.status ?? "enabled", createdAt: now, updatedAt: now,
      });
      await transaction.insertPostgresPriceTiers("provider_model_cost_tiers", "providerModelCostId", row.id, tiers, "provider_cost_tier");
      return { ...row, tiers: await transaction.listProviderModelCostTiers(row.id) };
    });
  }

  async updateProviderModelCostStatus(id: string, status: string): Promise<ProviderModelCost | undefined> {
    const existing = await this.one<ProviderModelCost>(`SELECT * FROM "provider_model_costs" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const updated = await this.updateRow<ProviderModelCost>("provider_model_costs", id, { status: postgresNormalizeToggleStatus(status), updatedAt: nowIso() });
    return updated ? { ...updated, tiers: await this.listProviderModelCostTiers(updated.id) } : undefined;
  }

  async findEnabledAccessPointPrice(accessPointId: string): Promise<AccessPointPrice | undefined> {
    const price = await this.one<AccessPointPrice>(
      `SELECT * FROM "access_point_prices"
       WHERE "access_point_id" = $1 AND "status" = 'enabled'
       ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
      [accessPointId],
    );
    return price ? { ...price, tiers: await this.listAccessPointPriceTiers(price.id) } : undefined;
  }

  async findEnabledAccessPointPrices(accessPointIds: readonly string[]): Promise<AccessPointPrice[]> {
    const requested = [...new Set(accessPointIds)];
    if (requested.length === 0) return [];
    const prices = await this.rows<AccessPointPrice>(
      `SELECT DISTINCT ON ("access_point_id") *
       FROM "access_point_prices"
       WHERE "access_point_id" = ANY($1::text[]) AND "status" = 'enabled'
       ORDER BY "access_point_id" ASC, "created_at" DESC, "id" DESC`,
      [requested],
    );
    if (prices.length === 0) return [];
    const tiers = await this.rows<AccessPointPriceTier>(
      `SELECT * FROM "access_point_price_tiers"
       WHERE "access_point_price_id" = ANY($1::text[])
       ORDER BY "access_point_price_id" ASC, "min_input_tokens" ASC, "tier_key" ASC`,
      [prices.map((price) => price.id)],
    );
    const tiersByPriceId = new Map<string, AccessPointPriceTier[]>();
    for (const tier of tiers) {
      const priceTiers = tiersByPriceId.get(tier.accessPointPriceId) ?? [];
      priceTiers.push(tier);
      tiersByPriceId.set(tier.accessPointPriceId, priceTiers);
    }
    return prices.map((price) => ({ ...price, tiers: tiersByPriceId.get(price.id) ?? [] }));
  }

  async createAccessPointPrice(input: {
    accessPointId: string;
    inputPer1M: number;
    cachedInputPer1M: number;
    cacheWritePer1M?: number | null;
    outputPer1M: number;
    status?: string;
    tiers?: PriceTierInput[];
  }, audit: AuditInput): Promise<AccessPointPrice> {
    const accessPoint = await this.getAccessPoint(input.accessPointId);
    if (!accessPoint) throw new RelayError("access_point_not_found", `AccessPoint ${input.accessPointId} not found`, 404);
    postgresValidatePrice(input);
    const now = nowIso();
    const tiers = postgresNormalizePriceTiers(input.tiers ?? [], "access_point_price_tier");
    return this.withRetriedTransaction(async (transaction) => {
      const row = await transaction.insertRow<AccessPointPrice>("access_point_prices", {
        id: createId("access_price"), accessPointId: input.accessPointId, inputPer1M: input.inputPer1M,
        cachedInputPer1M: input.cachedInputPer1M, cacheWritePer1M: input.cacheWritePer1M === undefined ? input.inputPer1M : input.cacheWritePer1M,
        outputPer1M: input.outputPer1M, status: input.status ?? "enabled", createdAt: now, updatedAt: now,
      });
      await transaction.insertPostgresPriceTiers("access_point_price_tiers", "accessPointPriceId", row.id, tiers, "access_price_tier");
      const result = { ...row, tiers: await transaction.listAccessPointPriceTiers(row.id) };
      await transaction.audit({
        ...audit,
        action: "access_point_price.create",
        resource: { resourceType: "access_point_price", resourceId: row.id },
        result: "success",
        metadata: { accessPointId: row.accessPointId, priceSource: "explicit", tierCount: tiers.length },
      });
      return result;
    });
  }

  async updateAccessPointPriceStatus(id: string, status: string): Promise<AccessPointPrice | undefined> {
    const existing = await this.one<AccessPointPrice>(`SELECT * FROM "access_point_prices" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const updated = await this.updateRow<AccessPointPrice>("access_point_prices", id, { status: postgresNormalizeToggleStatus(status), updatedAt: nowIso() });
    return updated ? { ...updated, tiers: await this.listAccessPointPriceTiers(updated.id) } : undefined;
  }

  async createPlanAccessPointPrice(input: {
    planId: string;
    accessPointId: string;
    inputPer1M: number;
    cachedInputPer1M: number;
    cacheWritePer1M?: number | null;
    outputPer1M: number;
    status?: string;
    tiers?: PriceTierInput[];
  }): Promise<PlanAccessPointPrice> {
    const [plan, accessPoint] = await Promise.all([this.getPlan(input.planId), this.getAccessPoint(input.accessPointId)]);
    if (!plan) throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
    if (!accessPoint) throw new RelayError("access_point_not_found", `AccessPoint ${input.accessPointId} not found`, 404);
    postgresValidatePrice(input);
    const tiers = postgresNormalizePriceTiers(input.tiers ?? [], "plan_access_point_price_tier");
    const now = nowIso();
    return this.withRetriedTransaction(async (transaction) => {
      const row = await transaction.insertRow<PlanAccessPointPrice>("plan_access_point_prices", {
        id: createId("plan_ap_price"), planId: input.planId, accessPointId: input.accessPointId,
        inputPer1M: input.inputPer1M, cachedInputPer1M: input.cachedInputPer1M,
        cacheWritePer1M: input.cacheWritePer1M === undefined ? input.inputPer1M : input.cacheWritePer1M,
        outputPer1M: input.outputPer1M, status: input.status ?? "enabled", createdAt: now, updatedAt: now,
      });
      await transaction.insertPostgresPriceTiers("plan_access_point_price_tiers", "planAccessPointPriceId", row.id, tiers, "plan_ap_price_tier");
      return { ...row, tiers: await transaction.listPlanAccessPointPriceTiers(row.id) };
    });
  }

  async updatePlanAccessPointPriceStatus(id: string, status: string): Promise<PlanAccessPointPrice | undefined> {
    const existing = await this.one<PlanAccessPointPrice>(`SELECT * FROM "plan_access_point_prices" WHERE "id" = $1`, [id]);
    if (!existing) return undefined;
    const updated = await this.updateRow<PlanAccessPointPrice>("plan_access_point_prices", id, { status: postgresNormalizeToggleStatus(status), updatedAt: nowIso() });
    return updated ? { ...updated, tiers: await this.listPlanAccessPointPriceTiers(updated.id) } : undefined;
  }

  async findEffectivePlanAccessPointPrices(
    input: readonly { planId: string; accessPointId: string }[],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["findEffectivePlanAccessPointPrices"]>>> {
    const requested = [...new Map(input.map((item) => [`${item.planId}\u0000${item.accessPointId}`, item])).values()];
    if (requested.length === 0) return [];
    const requestedJson = JSON.stringify(requested);
    const included = await this.rows<{ planId: string; accessPointId: string }>(
      `WITH requested AS (
         SELECT "planId", "accessPointId"
         FROM jsonb_to_recordset($1::jsonb) AS request("planId" text, "accessPointId" text)
       )
       SELECT DISTINCT requested."planId" AS "planId", requested."accessPointId" AS "accessPointId"
       FROM requested
       INNER JOIN "plan_access_points" relation
         ON relation."plan_id" = requested."planId" AND relation."access_point_id" = requested."accessPointId"
       ORDER BY requested."planId" ASC, requested."accessPointId" ASC`,
      [requestedJson],
    );
    if (included.length === 0) return [];

    const accessPointIds = [...new Set(included.map((item) => item.accessPointId))];
    const basePrices = await this.rows<AccessPointPrice>(
      `SELECT DISTINCT ON ("access_point_id") *
       FROM "access_point_prices"
       WHERE "access_point_id" = ANY($1::text[]) AND "status" = 'enabled'
       ORDER BY "access_point_id" ASC, "created_at" DESC, "id" DESC`,
      [accessPointIds],
    );
    const planPrices = await this.rows<PlanAccessPointPrice>(
      `WITH requested AS (
         SELECT "planId", "accessPointId"
         FROM jsonb_to_recordset($1::jsonb) AS request("planId" text, "accessPointId" text)
       )
       SELECT price.*
       FROM requested
       CROSS JOIN LATERAL (
         SELECT candidate.*
         FROM "plan_access_point_prices" candidate
         WHERE candidate."plan_id" = requested."planId"
           AND candidate."access_point_id" = requested."accessPointId"
           AND candidate."status" = 'enabled'
         ORDER BY candidate."created_at" DESC, candidate."id" DESC
         LIMIT 1
       ) price
       ORDER BY price."plan_id" ASC, price."access_point_id" ASC`,
      [JSON.stringify(included)],
    );
    const [baseTiers, planTiers] = await Promise.all([
      basePrices.length === 0 ? Promise.resolve([] as AccessPointPriceTier[]) : this.rows<AccessPointPriceTier>(
        `SELECT * FROM "access_point_price_tiers"
         WHERE "access_point_price_id" = ANY($1::text[])
         ORDER BY "access_point_price_id" ASC, "min_input_tokens" ASC, "tier_key" ASC`,
        [basePrices.map((price) => price.id)],
      ),
      planPrices.length === 0 ? Promise.resolve([] as PlanAccessPointPriceTier[]) : this.rows<PlanAccessPointPriceTier>(
        `SELECT * FROM "plan_access_point_price_tiers"
         WHERE "plan_access_point_price_id" = ANY($1::text[])
         ORDER BY "plan_access_point_price_id" ASC, "min_input_tokens" ASC, "tier_key" ASC`,
        [planPrices.map((price) => price.id)],
      ),
    ]);
    const baseTiersByPriceId = new Map<string, AccessPointPriceTier[]>();
    for (const tier of baseTiers) {
      const tiers = baseTiersByPriceId.get(tier.accessPointPriceId) ?? [];
      tiers.push(tier);
      baseTiersByPriceId.set(tier.accessPointPriceId, tiers);
    }
    const planTiersByPriceId = new Map<string, PlanAccessPointPriceTier[]>();
    for (const tier of planTiers) {
      const tiers = planTiersByPriceId.get(tier.planAccessPointPriceId) ?? [];
      tiers.push(tier);
      planTiersByPriceId.set(tier.planAccessPointPriceId, tiers);
    }
    const baseByAccessPointId = new Map(basePrices.map((price) => [price.accessPointId, {
      ...price,
      tiers: baseTiersByPriceId.get(price.id) ?? [],
    }]));
    const planByKey = new Map(planPrices.map((price) => [`${price.planId}\u0000${price.accessPointId}`, {
      ...price,
      tiers: planTiersByPriceId.get(price.id) ?? [],
    }]));
    return included.flatMap(({ planId, accessPointId }) => {
      const basePrice = baseByAccessPointId.get(accessPointId) ?? null;
      const planAccessPointPrice = planByKey.get(`${planId}\u0000${accessPointId}`) ?? null;
      const price = planAccessPointPrice ?? basePrice;
      if (!price) return [];
      return [{
        planId,
        accessPointId,
        effectivePrice: {
          price,
          source: planAccessPointPrice ? "plan_access_point" as const : "access_point" as const,
          basePrice,
          planAccessPointPrice,
        },
      }];
    });
  }

  async findEffectivePlanAccessPointPrice(planId: string, accessPointId: string): Promise<EffectivePlanAccessPointPrice | undefined> {
    const included = await this.query(`SELECT 1 FROM "plan_access_points" WHERE "plan_id" = $1 AND "access_point_id" = $2`, [planId, accessPointId]);
    if (included.rows.length === 0) return undefined;
    const [basePrice, planPrice] = await Promise.all([
      this.findEnabledAccessPointPrice(accessPointId),
      this.one<PlanAccessPointPrice>(
        `SELECT * FROM "plan_access_point_prices"
         WHERE "plan_id" = $1 AND "access_point_id" = $2 AND "status" = 'enabled'
         ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
        [planId, accessPointId],
      ),
    ]);
    const hydratedPlanPrice = planPrice ? { ...planPrice, tiers: await this.listPlanAccessPointPriceTiers(planPrice.id) } : null;
    if (hydratedPlanPrice) return { price: hydratedPlanPrice, source: "plan_access_point", basePrice: basePrice ?? null, planAccessPointPrice: hydratedPlanPrice };
    if (basePrice) return { price: basePrice, source: "access_point", basePrice, planAccessPointPrice: null };
    return undefined;
  }

  async createBillingEvent(input: Parameters<ApplicationOperationPort["createBillingEvent"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createBillingEvent"]>>> {
    const row = {
      ...input,
      id: input.id ?? createId("billing"),
      createdAt: input.createdAt ?? nowIso(),
      billablePriceTierKey: input.billablePriceTierKey ?? "legacy_flat",
      providerCostTierKey: input.providerCostTierKey ?? "legacy_flat",
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      operationKind: input.operationKind ?? "inference",
      billablePriceSnapshotJson: input.billablePriceSnapshotJson ?? JSON.stringify({ priceId: input.billablePriceId, source: input.billablePriceSource }),
      costPriceSnapshotJson: input.costPriceSnapshotJson ?? JSON.stringify({ priceId: input.providerModelCostId }),
    };
    return this.withRetriedTransaction(async (transaction) => {
      const event = await transaction.insertRow<Awaited<ReturnType<ApplicationOperationPort["createBillingEvent"]>>>("billing_events", row);
      await transaction.insertRow("billing_history_refs", billingHistoryReference(event));
      return event;
    });
  }

  async createBillingAccessPointEdge(input: Parameters<ApplicationOperationPort["createBillingAccessPointEdge"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createBillingAccessPointEdge"]>>> {
    const row = {
      ...input,
      id: input.id ?? createId("billing_ap_edge"),
      createdAt: input.createdAt ?? nowIso(),
      priceTierKey: input.priceTierKey ?? "legacy_flat",
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      priceSnapshotJson: input.priceSnapshotJson ?? JSON.stringify({ priceId: input.accessPointPriceId, source: "access_point" }),
    };
    return this.insertRow<Awaited<ReturnType<ApplicationOperationPort["createBillingAccessPointEdge"]>>>("billing_access_point_edges", row);
  }

  async createBillingProviderCostEvent(input: Parameters<ApplicationOperationPort["createBillingProviderCostEvent"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createBillingProviderCostEvent"]>>> {
    if (input.operationKind !== undefined && input.operationKind !== "compaction" && input.operationKind !== "inference") {
      throw new RelayError("invalid_provider_operation_kind", "Provider operation kind is invalid", 400);
    }
    const row = {
      ...input,
      id: input.id ?? createId("billing_provider_cost"),
      createdAt: input.createdAt ?? nowIso(),
      providerAttemptId: input.providerAttemptId ?? null,
      operationKind: input.operationKind ?? "inference",
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      costTierKey: input.costTierKey ?? "legacy_flat",
      costSnapshotJson: input.costSnapshotJson ?? JSON.stringify({ priceId: input.providerModelCostId }),
    };
    return this.insertRow<Awaited<ReturnType<ApplicationOperationPort["createBillingProviderCostEvent"]>>>("billing_provider_cost_events", row);
  }

  async createBillingEventWithFacts(input: Parameters<ApplicationOperationPort["createBillingEventWithFacts"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createBillingEventWithFacts"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const billingEvent = await transaction.createBillingEvent(input.billingEvent);
      for (const edge of input.accessPointEdges ?? []) await transaction.createBillingAccessPointEdge(edge);
      for (const event of [...(input.providerCostEvents ?? []), ...(input.providerCostEvent ? [input.providerCostEvent] : [])]) {
        await transaction.createBillingProviderCostEvent(event);
      }
      if (!billingEvent.billingSubscriptionId) throw new RelayError("billing_subscription_required", "Billing event requires a plan subscription", 500);
      await transaction.recordUsageSellerSettlement(billingEvent, input.accessPointEdges ?? []);
      return { billingEvent };
    });
  }

  async createBillingEventWithUsageCharge(input: Parameters<ApplicationOperationPort["createBillingEventWithUsageCharge"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createBillingEventWithUsageCharge"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const billingEvent = await transaction.createBillingEvent(input.billingEvent);
      for (const edge of input.accessPointEdges ?? []) await transaction.createBillingAccessPointEdge(edge);
      for (const event of [...(input.providerCostEvents ?? []), ...(input.providerCostEvent ? [input.providerCostEvent] : [])]) {
        await transaction.createBillingProviderCostEvent(event);
      }
      if (!billingEvent.billingSubscriptionId) throw new RelayError("billing_subscription_required", "Billing event requires a plan subscription", 500);
      const amountUnits = -Math.abs(creditUnitsFromUsd(billingEvent.billableAmount));
      if (amountUnits === 0) {
        await transaction.recordUsageSellerSettlement(billingEvent, input.accessPointEdges ?? []);
        return { billingEvent, ledgerEvent: null };
      }
      const account = await transaction.getCreditAccount(input.usageChargeAccountId);
      if (!account) throw new RelayError("credit_account_not_found", `Credit account ${input.usageChargeAccountId} not found`, 404);
      if (account.status !== "active") throw new RelayError("credit_account_inactive", "Usage charge account must be active", 402);
      const ledgerId = createId("ledger");
      const createdAt = nowIso();
      const updated = await transaction.query(
        `UPDATE "credit_accounts"
         SET "balance_snap_units" = "balance_snap_units" + $2,
             "balance_snap_ledger_event_id" = $3,
             "balance_snap_updated_at" = $4,
             "updated_at" = $5
         WHERE "id" = $1 AND "status" = 'active'
           AND ($6::boolean OR "balance_snap_units"
             - COALESCE((SELECT SUM("held_units") FROM "usage_reservations" WHERE "credit_account_id" = $1 AND "status" IN ('active', 'reconciling')), 0)
               >= $7)
         RETURNING "id"`,
        [account.id, amountUnits, ledgerId, createdAt, createdAt, input.allowOverdraft === true, Math.abs(amountUnits)],
      );
      if (!updated.rows[0]) throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient", 402);
      const ledgerEvent = await transaction.insertRow<Awaited<ReturnType<ApplicationOperationPort["createCreditLedgerEvent"]>>>("credit_ledger_events", {
        id: ledgerId,
        accountId: account.id,
        eventType: "usage_charge",
        amountUnits,
        transferId: null,
        relatedEventId: null,
        planSubscriptionId: billingEvent.billingSubscriptionId,
        authorityPurchaseId: null,
        billingEventId: billingEvent.id,
        relatedTopupId: null,
        cardId: null,
        fromAccountId: account.id,
        toAccountId: null,
        reason: `usage:${billingEvent.requestId}`,
        actorUserId: input.actorUserId ?? null,
        createdAt,
      });
      await transaction.recordUsageSellerSettlement(billingEvent, input.accessPointEdges ?? []);
      return { billingEvent, ledgerEvent };
    });
  }

  async settleProviderUsage(
    input: Parameters<ApplicationOperationPort["settleProviderUsage"]>[0],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["settleProviderUsage"]>>> {
    if (!input.requiresUsageCharge) return this.createBillingEventWithFacts(input.facts);
    if (!input.usageChargeAccountId) throw new RelayError("usage_charge_account_not_found", "Provider usage requires a charge account", 402);
    return this.createBillingEventWithUsageCharge({
      ...input.facts,
      usageChargeAccountId: input.usageChargeAccountId,
      actorUserId: input.actorUserId,
      allowOverdraft: input.allowUsageOverdraft,
    });
  }

  async backfillPrepaidSellerSettlements(batchSize = 100, lease?: PostgresTaskLease): Promise<{ backfilledPurchases: number; completed: boolean }> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new RelayError("seller_settlement_batch_invalid", "Seller settlement batch size must be between 1 and 500", 400);
    return this.withRetriedTransaction(async (transaction) => {
      const cutover = await transaction.one<{ migrationName: string }>(
        `SELECT "migration_name" AS "migrationName" FROM "_prisma_migrations"
         WHERE "migration_name" = '20260820000000_task_leases'
           AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL AND "applied_steps_count" > 0
         FOR SHARE`,
        [],
      );
      if (!cutover) throw new RelayError("seller_settlement_backfill_cutover_incomplete", "Prepaid Seller settlement backfill requires the completed writer cutover migration", 409);
      const completed = await transaction.one<{ backfillKey: string }>(
        `SELECT "backfill_key" FROM "seller_settlement_backfill_state" WHERE "backfill_key" = 'prepaid-v1'`,
        [],
      );
      if (completed) return { backfilledPurchases: 0, completed: true };
      const candidates = await transaction.rows<{
        subscriptionId: string;
        effectiveStart: string;
        effectiveEnd: string | null;
        durationSeconds: number;
        sellerScopeRef: ScopeRef;
        amountUnits: number;
        sourceType: "plan_purchase" | "plan_purchase_order" | "card_purchase";
        sourceId: string;
        createdAt: string;
      }>(
        `WITH RECURSIVE card_subscriptions AS MATERIALIZED (
           SELECT subscription."id", subscription."origin_card_id"
           FROM "plan_subscriptions" subscription
           INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."billing_mode" = 'prepaid'
           INNER JOIN "cards" origin_card ON origin_card."id" = subscription."origin_card_id" AND origin_card."issuance_type" = 'purchase'
           WHERE subscription."origin_card_id" IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM "seller_settlement_events" settlement
               WHERE settlement."plan_subscription_id" = subscription."id"
                 AND settlement."event_type" = 'revenue'
                 AND settlement."source_type" IN ('plan_purchase_order', 'card_purchase')
             )
           ORDER BY subscription."created_at", subscription."id"
           LIMIT $1
         ), card_chain AS (
           SELECT subscription."id" AS subscription_id, card."id" AS card_id, card."replaces_card_id"
           FROM card_subscriptions subscription
           INNER JOIN "cards" card ON card."id" = subscription."origin_card_id"
           UNION ALL
           SELECT chain.subscription_id, parent."id", parent."replaces_card_id"
           FROM card_chain chain INNER JOIN "cards" parent ON parent."id" = chain."replaces_card_id"
         ), root_cards AS (
           SELECT subscription_id, card_id FROM card_chain WHERE replaces_card_id IS NULL
         ), candidates AS (
           SELECT subscription."id" AS subscription_id, subscription."effective_start", subscription."effective_end", plan."duration_seconds",
                  plan."scope_ref" AS seller_scope_ref, -ledger."amount_units" AS amount_units,
                  'plan_purchase'::text AS source_type, ledger."id" AS source_id, ledger."created_at"
           FROM "credit_ledger_events" ledger
           INNER JOIN "plan_subscriptions" subscription ON subscription."id" = ledger."plan_subscription_id"
           INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."billing_mode" = 'prepaid'
           WHERE ledger."event_type" = 'plan_purchase' AND ledger."amount_units" < 0
           UNION ALL
           SELECT subscription."id", subscription."effective_start", subscription."effective_end", plan."duration_seconds",
                  plan."scope_ref", purchase."canonical_purchase_amount_units",
                  'plan_purchase_order'::text, purchase."id", COALESCE(purchase."fulfilled_at", purchase."created_at")
           FROM root_cards root
           INNER JOIN "plan_subscriptions" subscription ON subscription."id" = root.subscription_id
           INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."billing_mode" = 'prepaid'
           INNER JOIN "plan_purchase_orders" purchase ON purchase."card_id" = root.card_id AND purchase."status" IN ('fulfilled', 'reversed')
           WHERE purchase."canonical_purchase_amount_units" > 0
           UNION ALL
           SELECT subscription."id", subscription."effective_start", subscription."effective_end", plan."duration_seconds",
                  plan."scope_ref", -ledger."amount_units",
                  'card_purchase'::text, ledger."id", ledger."created_at"
           FROM root_cards root
           INNER JOIN "plan_subscriptions" subscription ON subscription."id" = root.subscription_id
           INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."billing_mode" = 'prepaid'
           INNER JOIN "credit_ledger_events" ledger ON ledger."card_id" = root.card_id AND ledger."event_type" = 'card_purchase' AND ledger."amount_units" < 0
           WHERE NOT EXISTS (SELECT 1 FROM "plan_purchase_orders" purchase WHERE purchase."card_id" = root.card_id AND purchase."status" IN ('fulfilled', 'reversed'))
         )
         SELECT candidates."subscription_id", candidates."effective_start", candidates."effective_end", candidates."duration_seconds",
                candidates."seller_scope_ref", candidates."amount_units", candidates."source_type", candidates."source_id", candidates."created_at"
         FROM candidates
         WHERE NOT EXISTS (
             SELECT 1 FROM "seller_settlement_events" settlement
             WHERE settlement."event_type" = 'revenue'
               AND settlement."source_type" = candidates."source_type"
               AND settlement."source_id" = candidates."source_id"
           )
         ORDER BY candidates."created_at", candidates."source_id"
         LIMIT $1`,
        [batchSize],
      );
      for (const candidate of candidates) await transaction.recordPrepaidSellerRevenue({
        subscription: {
          id: candidate.subscriptionId,
          effectiveStart: candidate.effectiveStart,
          effectiveEnd: postgresAddSeconds(candidate.effectiveStart, safePostgresInteger(candidate.durationSeconds, "seller_settlement_duration_invalid")),
        },
        sellerScopeRef: candidate.sellerScopeRef,
        amountUnits: safePostgresInteger(candidate.amountUnits, "seller_settlement_amount_invalid"),
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        createdAt: candidate.createdAt,
        ...(lease ? { lease } : {}),
      });
      const backfillCompleted = candidates.length < batchSize;
      if (backfillCompleted) {
        const completedAt = await transaction.currentDatabaseTime();
        const marker = await transaction.query(
          `INSERT INTO "seller_settlement_backfill_state" ("backfill_key", "completed_at")
           SELECT 'prepaid-v1', $1
           WHERE $2::text IS NULL OR EXISTS (
             SELECT 1 FROM "friday_relay_task_leases"
             WHERE "task_key" = $2 AND "owner_id" = $3 AND "fencing_token" = $4
               AND "lease_until_ms" > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           )
           ON CONFLICT ("backfill_key") DO NOTHING
           RETURNING "backfill_key"`,
          [completedAt, lease?.taskKey ?? null, lease?.ownerId ?? null, lease?.fencingToken ?? null],
        );
        if (!marker.rows[0] && lease) await transaction.taskLeases.assertHeld(lease);
      }
      return { backfilledPurchases: candidates.length, completed: backfillCompleted };
    });
  }

  private async recordPrepaidSellerRevenue(input: {
    subscription: Pick<PlanSubscription, "id" | "effectiveStart" | "effectiveEnd">;
    sellerScopeRef: ScopeRef;
    amountUnits: number;
    sourceType: "plan_purchase" | "plan_purchase_order" | "card_purchase";
    sourceId: string;
    createdAt: string;
    lease?: PostgresTaskLease;
  }): Promise<void> {
    for (const tranche of prepaidSellerSettlementTranches(input.subscription, input.amountUnits)) {
      if (tranche.amountUnits <= 0) continue;
      await this.insertSellerSettlementEvent({
        planSubscriptionId: input.subscription.id,
        sellerScopeRef: input.sellerScopeRef,
        windowStart: tranche.windowStart,
        windowEnd: tranche.windowEnd,
        releaseAt: tranche.windowEnd,
        eventType: "revenue",
        amountUnits: tranche.amountUnits,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        createdAt: input.createdAt,
        ...(input.lease ? { lease: input.lease } : {}),
      });
    }
  }

  async recordUsageSellerSettlement(
    billingEvent: Awaited<ReturnType<ApplicationOperationPort["createBillingEvent"]>>,
    accessPointEdges: Array<Parameters<ApplicationOperationPort["createBillingAccessPointEdge"]>[0]>,
  ): Promise<void> {
    if (!billingEvent.billingSubscriptionId) return;
    const subscription = await this.one<Awaited<ReturnType<ApplicationOperationPort["findActivePlanSubscriptions"]>>[number]>(
      `SELECT * FROM "plan_subscriptions" WHERE "id" = $1`,
      [billingEvent.billingSubscriptionId],
    );
    if (!subscription) return;
    const plan = await this.getPlan(subscription.planId);
    if (!plan) return;
    const window = sellerSettlementWindowFor(subscription, billingEvent.createdAt);
    if (plan.billingMode === "paygo" && billingEvent.billableAmount > 0) {
      await this.insertSellerSettlementEvent({
        planSubscriptionId: subscription.id,
        sellerScopeRef: plan.scopeRef as ScopeRef,
        ...window,
        eventType: "revenue",
        amountUnits: creditUnitsFromUsd(billingEvent.billableAmount),
        sourceType: "billing_event",
        sourceId: billingEvent.id,
        createdAt: billingEvent.createdAt,
      });
    }
    const entryEdge = accessPointEdges[0];
    if (entryEdge && entryEdge.sellerScopeRef !== plan.scopeRef && entryEdge.amount > 0) {
      await this.insertSellerSettlementEvent({
        planSubscriptionId: subscription.id,
        sellerScopeRef: plan.scopeRef as ScopeRef,
        ...window,
        eventType: "upstream_cost",
        amountUnits: creditUnitsFromUsd(entryEdge.amount),
        sourceType: "billing_event",
        sourceId: billingEvent.id,
        createdAt: billingEvent.createdAt,
      });
    }
  }

  private async insertSellerSettlementEvent(input: {
    planSubscriptionId?: string | null;
    authorityPurchaseId?: string | null;
    sellerScopeRef: ScopeRef;
    windowStart: string;
    windowEnd: string;
    releaseAt: string;
    eventType: "revenue" | "upstream_cost" | "reversal" | "release";
    amountUnits: number;
    sourceType: string;
    sourceId: string;
    createdAt: string;
    lease?: PostgresTaskLease;
  }): Promise<SellerSettlementEvent | null> {
    if (!Number.isSafeInteger(input.amountUnits) || input.amountUnits <= 0) throw new RelayError("invalid_seller_settlement_amount", "Seller settlement amount must be a positive integer", 500);
    const hasPlanSubscription = input.planSubscriptionId !== null && input.planSubscriptionId !== undefined;
    const hasAuthorityPurchase = input.authorityPurchaseId !== null && input.authorityPurchaseId !== undefined;
    if (hasPlanSubscription === hasAuthorityPurchase) throw new RelayError("seller_settlement_source_missing", "Seller settlement event requires exactly one typed source", 500);
    const result = await this.query(
      `INSERT INTO "seller_settlement_events"
        ("id", "plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start", "window_end", "release_at", "event_type", "amount_units", "source_type", "source_id", "created_at")
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       WHERE $13::text IS NULL OR EXISTS (
         SELECT 1 FROM "friday_relay_task_leases"
         WHERE "task_key" = $13 AND "owner_id" = $14 AND "fencing_token" = $15
           AND "lease_until_ms" > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [createId("seller_settlement"), input.planSubscriptionId ?? null, input.authorityPurchaseId ?? null, input.sellerScopeRef, input.windowStart, input.windowEnd, input.releaseAt, input.eventType, input.amountUnits, input.sourceType, input.sourceId, input.createdAt, input.lease?.taskKey ?? null, input.lease?.ownerId ?? null, input.lease?.fencingToken ?? null],
    );
    const row = result.rows[0];
    if (!row && input.lease) await this.taskLeases.assertHeld(input.lease);
    return row ? mapPostgresRow<SellerSettlementEvent>(row) : null;
  }

  async listSellerSettlementEvents(sellerScopeRef?: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["listSellerSettlementEvents"]>>> {
    return this.rows<SellerSettlementEvent>(
      sellerScopeRef
        ? `SELECT * FROM "seller_settlement_events" WHERE "seller_scope_ref" = $1 ORDER BY "release_at" ASC, "created_at" ASC`
        : `SELECT * FROM "seller_settlement_events" ORDER BY "release_at" ASC, "created_at" ASC`,
      sellerScopeRef ? [sellerScopeRef] : [],
    );
  }

  async sellerSettlementBalance(sellerScopeRef: ScopeRef, at = nowIso()): Promise<Awaited<ReturnType<ApplicationOperationPort["sellerSettlementBalance"]>>> {
    const rows = await this.rows<{ releaseAt: string; netUnits: number; releasedUnits: number }>(
      `SELECT "release_at" AS "release_at",
          COALESCE(SUM(CASE "event_type" WHEN 'revenue' THEN "amount_units" WHEN 'upstream_cost' THEN -"amount_units" WHEN 'reversal' THEN -"amount_units" ELSE 0 END), 0)::bigint AS "net_units",
          COALESCE(SUM(CASE "event_type" WHEN 'release' THEN "amount_units" ELSE 0 END), 0)::bigint AS "released_units"
        FROM "seller_settlement_events"
        WHERE "seller_scope_ref" = $1
        GROUP BY "plan_subscription_id", "authority_purchase_id", "window_start", "release_at"`,
      [sellerScopeRef],
    );
    let frozenUnits = 0;
    let releasableUnits = 0;
    let releasedUnits = 0;
    for (const row of rows) {
      const netUnits = safePostgresInteger(row.netUnits, "seller_settlement_net_units_invalid");
      const windowReleasedUnits = safePostgresInteger(row.releasedUnits, "seller_settlement_released_units_invalid");
      const remaining = Math.max(0, netUnits - windowReleasedUnits);
      if (row.releaseAt <= at) releasableUnits += remaining;
      else frozenUnits += remaining;
      releasedUnits += windowReleasedUnits;
    }
    return { frozenUnits, releasableUnits, releasedUnits };
  }

  async releaseDueSellerSettlements(
    at?: string,
    lease?: PostgresTaskLease,
    batchSize = 100,
  ): Promise<{ selectedWindows: number; deferredWindows: number; releasedWindows: number; releasedUnits: number; ledgerEventIds: string[] }> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new RelayError("seller_settlement_batch_invalid", "Seller settlement batch size must be between 1 and 500", 400);
    return this.withRetriedTransaction(async (transaction) => {
      const effectiveAt = at ?? await transaction.currentDatabaseTime();
      const windows = await transaction.rows<{
        windowKey: string;
        planSubscriptionId: string | null;
        authorityPurchaseId: string | null;
        sellerScopeRef: ScopeRef;
        windowStart: string;
        windowEnd: string;
        releaseAt: string;
      }>(
        `SELECT "window_key", "plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start", "window_end", "release_at"
         FROM "seller_settlement_windows"
         WHERE "status" = 'open' AND "release_at" <= $1 AND "next_attempt_at" <= $1
         ORDER BY "next_attempt_at", "release_at", "window_key"
         LIMIT $2`,
        [effectiveAt, batchSize],
      );
      let deferredWindows = 0;
      let releasedUnits = 0;
      const ledgerEventIds: string[] = [];
      for (const candidate of windows) {
        const projection = await transaction.one<{ status: string }>(
          `SELECT "status" FROM "seller_settlement_windows" WHERE "window_key" = $1 FOR UPDATE`,
          [candidate.windowKey],
        );
        if (projection?.status !== "open") continue;
        const typedSourceId = candidate.planSubscriptionId ?? candidate.authorityPurchaseId;
        if (!typedSourceId || (candidate.planSubscriptionId !== null && candidate.authorityPurchaseId !== null)) throw new RelayError("seller_settlement_source_missing", "Seller settlement window has no unique typed source", 500);
        if (candidate.planSubscriptionId) {
          await transaction.query(`SELECT "id" FROM "plan_subscriptions" WHERE "id" = $1 FOR UPDATE`, [candidate.planSubscriptionId]);
          const unresolved = await transaction.one<{ id: string }>(
            `SELECT attempt."id"
             FROM "request_provider_attempts" attempt
             LEFT JOIN "budget_claims" claim ON claim."provider_attempt_id" = attempt."id"
             WHERE ((attempt."invocation_contract" = 'protected@1' AND claim."plan_subscription_id" = $1)
                 OR (attempt."invocation_contract" = 'cpa-basic@1' AND attempt."plan_subscription_id" = $1))
               AND attempt."started_at" >= $2 AND attempt."started_at" < $3
               AND attempt."usage_settled" = 0
               AND NOT (
                 attempt."invocation_contract" = 'cpa-basic@1'
                 AND attempt."cost_exposure" = 'not_started'
                 AND attempt."final_usage_evidence" = 'absent'
               )
             LIMIT 1`,
            [candidate.planSubscriptionId, candidate.windowStart, candidate.windowEnd],
          );
          if (unresolved) {
            const deferred = await transaction.query(
              `UPDATE "seller_settlement_windows"
               SET "next_attempt_at" = $2, "updated_at" = $3
               WHERE "window_key" = $1 AND "status" = 'open'
                 AND ($4::text IS NULL OR EXISTS (
                   SELECT 1 FROM "friday_relay_task_leases"
                   WHERE "task_key" = $4 AND "owner_id" = $5 AND "fencing_token" = $6
                     AND "lease_until_ms" > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                 ))
               RETURNING "window_key"`,
              [candidate.windowKey, postgresAddSeconds(effectiveAt, 60), effectiveAt, lease?.taskKey ?? null, lease?.ownerId ?? null, lease?.fencingToken ?? null],
            );
            if (!deferred.rows[0] && lease) await transaction.taskLeases.assertHeld(lease);
            deferredWindows += 1;
            continue;
          }
        } else {
          await transaction.query(`SELECT "id" FROM "authority_purchases" WHERE "id" = $1 FOR UPDATE`, [candidate.authorityPurchaseId]);
        }
        const window = await transaction.one<{
          sellerScopeRef: ScopeRef;
          windowEnd: string;
          releaseAt: string;
          netUnits: number;
          releasedUnits: number;
        }>(
          `SELECT MIN("seller_scope_ref") AS "seller_scope_ref", MIN("window_end") AS "window_end", MIN("release_at") AS "release_at",
              COALESCE(SUM(CASE "event_type" WHEN 'revenue' THEN "amount_units" WHEN 'upstream_cost' THEN -"amount_units" WHEN 'reversal' THEN -"amount_units" ELSE 0 END), 0)::bigint AS "net_units",
              COALESCE(SUM(CASE "event_type" WHEN 'release' THEN "amount_units" ELSE 0 END), 0)::bigint AS "released_units"
           FROM "seller_settlement_events"
           WHERE "plan_subscription_id" IS NOT DISTINCT FROM $1
             AND "authority_purchase_id" IS NOT DISTINCT FROM $2
             AND "seller_scope_ref" = $3 AND "window_start" = $4`,
          [candidate.planSubscriptionId, candidate.authorityPurchaseId, candidate.sellerScopeRef, candidate.windowStart],
        );
        if (!window) continue;
        const amountUnits = Math.max(0,
          safePostgresInteger(window.netUnits, "seller_settlement_net_units_invalid")
          - safePostgresInteger(window.releasedUnits, "seller_settlement_released_units_invalid"));
        if (amountUnits <= 0) {
          const closed = await transaction.query(
            `UPDATE "seller_settlement_windows"
             SET "status" = 'non_positive', "updated_at" = $2
             WHERE "window_key" = $1 AND "status" = 'open'
               AND ($3::text IS NULL OR EXISTS (
                 SELECT 1 FROM "friday_relay_task_leases"
                 WHERE "task_key" = $3 AND "owner_id" = $4 AND "fencing_token" = $5
                   AND "lease_until_ms" > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
               ))
             RETURNING "window_key"`,
            [candidate.windowKey, effectiveAt, lease?.taskKey ?? null, lease?.ownerId ?? null, lease?.fencingToken ?? null],
          );
          if (!closed.rows[0] && lease) await transaction.taskLeases.assertHeld(lease);
          continue;
        }
        const sourceId = `${candidate.planSubscriptionId ? "plan" : "authority"}:${typedSourceId}:${candidate.sellerScopeRef}:${candidate.windowStart}`;
        const settlement = await transaction.insertSellerSettlementEvent({
          planSubscriptionId: candidate.planSubscriptionId,
          authorityPurchaseId: candidate.authorityPurchaseId,
          sellerScopeRef: window.sellerScopeRef,
          windowStart: candidate.windowStart,
          windowEnd: window.windowEnd,
          releaseAt: window.releaseAt,
          eventType: "release",
          amountUnits,
          sourceType: "settlement_window",
          sourceId,
          createdAt: effectiveAt,
          ...(lease ? { lease } : {}),
        });
        if (!settlement) continue;
        const account = await transaction.getOrCreateActiveCreditAccount(window.sellerScopeRef);
        const ledgerId = createId("ledger");
        const updated = await transaction.query(
          `UPDATE "credit_accounts"
           SET "balance_snap_units" = "balance_snap_units" + $2,
               "balance_snap_ledger_event_id" = $3,
               "balance_snap_updated_at" = $4,
               "updated_at" = $4
           WHERE "id" = $1 AND "status" = 'active'
             AND ($5::text IS NULL OR EXISTS (
               SELECT 1 FROM "friday_relay_task_leases"
               WHERE "task_key" = $5 AND "owner_id" = $6 AND "fencing_token" = $7
                 AND "lease_until_ms" > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
             ))
           RETURNING "id"`,
          [account.id, amountUnits, ledgerId, effectiveAt, lease?.taskKey ?? null, lease?.ownerId ?? null, lease?.fencingToken ?? null],
        );
        if (!updated.rows[0]) {
          if (lease) await transaction.taskLeases.assertHeld(lease);
          throw new RelayError("credit_account_inactive", "Seller settlement credit account is inactive", 409);
        }
        const ledgerEvent = await transaction.insertSellerSettlementLedgerEvent({
          id: ledgerId,
          accountId: account.id,
          amountUnits,
          planSubscriptionId: candidate.planSubscriptionId,
          authorityPurchaseId: candidate.authorityPurchaseId,
          reason: `seller_settlement:${candidate.windowStart}`,
          createdAt: effectiveAt,
          ...(lease ? { lease } : {}),
        });
        ledgerEventIds.push(ledgerEvent.id);
        releasedUnits += amountUnits;
      }
      return { selectedWindows: windows.length, deferredWindows, releasedWindows: ledgerEventIds.length, releasedUnits, ledgerEventIds };
    });
  }

  private async getOrCreateActiveCreditAccount(scopeRef: ScopeRef): Promise<CreditAccount> {
    const existing = await this.findCreditAccountForScope(scopeRef);
    if (existing) return existing;
    const now = nowIso();
    const inserted = await this.query(
      `INSERT INTO "credit_accounts" ("id", "scope_ref", "status", "balance_snap_units", "balance_snap_ledger_event_id", "balance_snap_updated_at", "created_at", "updated_at")
       VALUES ($1, $2, 'active', 0, NULL, NULL, $3, $3)
       ON CONFLICT ("scope_ref") DO NOTHING
       RETURNING *`,
      [createId("credit_account"), scopeRef, now],
    );
    const account = inserted.rows[0] ? mapPostgresRow<CreditAccount>(inserted.rows[0]) : await this.findCreditAccountForScope(scopeRef);
    if (!account) throw new RelayError("credit_account_inactive", "Seller settlement credit account is inactive", 409);
    return account;
  }

  private async insertSellerSettlementLedgerEvent(input: {
    id: string;
    accountId: string;
    amountUnits: number;
    planSubscriptionId: string | null;
    authorityPurchaseId: string | null;
    reason: string;
    createdAt: string;
    lease?: PostgresTaskLease;
  }): Promise<CreditLedgerEvent> {
    const result = await this.query(
      `INSERT INTO "credit_ledger_events"
        ("id", "account_id", "event_type", "amount_units", "transfer_id", "related_event_id", "plan_subscription_id", "authority_purchase_id", "billing_event_id", "related_topup_id", "card_id", "from_account_id", "to_account_id", "reason", "actor_user_id", "created_at")
       SELECT $1, $2, 'seller_settlement_release', $3, NULL, NULL, $4, $5, NULL, NULL, NULL, NULL, $2, $6, NULL, $7
       WHERE $8::text IS NULL OR EXISTS (
         SELECT 1 FROM "friday_relay_task_leases"
         WHERE "task_key" = $8 AND "owner_id" = $9 AND "fencing_token" = $10
           AND "lease_until_ms" > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       )
       RETURNING *`,
      [input.id, input.accountId, input.amountUnits, input.planSubscriptionId, input.authorityPurchaseId, input.reason, input.createdAt, input.lease?.taskKey ?? null, input.lease?.ownerId ?? null, input.lease?.fencingToken ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      if (input.lease) await this.taskLeases.assertHeld(input.lease);
      throw new Error("postgres_seller_settlement_ledger_insert_empty");
    }
    return mapPostgresRow<CreditLedgerEvent>(row);
  }

  async findActivePlanSubscriptions(scopeRef: ScopeRef, at = nowIso()): Promise<Awaited<ReturnType<ApplicationOperationPort["findActivePlanSubscriptions"]>>> {
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["findActivePlanSubscriptions"]>>[number]>(
      `SELECT subscription.*
       FROM "plan_subscriptions" subscription
       INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."scope_ref" = $1
         AND subscription."subscription_lifecycle" = 'active'
         AND subscription."effective_start" <= $2
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)
         AND plan."plan_status" IN ('enabled', 'closed')
       ORDER BY subscription."priority" ASC, subscription."effective_start" ASC,
                subscription."created_at" ASC, subscription."id" ASC`,
      [scopeRef, at],
    );
  }

  async listActiveSubscriptionsForUser(userId: string, at = nowIso()): Promise<Awaited<ReturnType<ApplicationOperationPort["listActiveSubscriptionsForUser"]>>> {
    const scopeRefs = await this.listEffectiveSubscriptionScopesForUser(userId);
    if (scopeRefs.length === 0) return [];
    const subscriptions = await this.rows<Awaited<ReturnType<ApplicationOperationPort["findActivePlanSubscriptions"]>>[number]>(
      `SELECT subscription.*
       FROM "plan_subscriptions" subscription
       INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
       WHERE subscription."scope_ref" = ANY($1::text[])
         AND subscription."subscription_lifecycle" = 'active'
         AND subscription."effective_start" <= $2
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)
         AND plan."plan_status" IN ('enabled', 'closed')`,
      [scopeRefs, at],
    );
    const planIds = [...new Set(subscriptions.map((subscription) => subscription.planId))];
    if (planIds.length === 0) return [];
    const plans = await this.rows<PlanDefinition>(`SELECT * FROM "plans" WHERE "id" = ANY($1::text[])`, [planIds]);
    const plansById = new Map(plans.map((plan) => [plan.id, plan]));
    const limitsByPlan = await this.listPlanBudgetLimitsForPlans(planIds);
    const scopeOrder = new Map(scopeRefs.map((scopeRef, index) => [scopeRef, index]));
    subscriptions.sort((left, right) =>
      (scopeOrder.get(left.scopeRef as ScopeRef) ?? Number.MAX_SAFE_INTEGER) - (scopeOrder.get(right.scopeRef as ScopeRef) ?? Number.MAX_SAFE_INTEGER)
      || left.priority - right.priority
      || left.effectiveStart.localeCompare(right.effectiveStart)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
    return subscriptions.flatMap((subscription) => {
      const plan = plansById.get(subscription.planId);
      return plan ? [{ scopeRef: subscription.scopeRef as ScopeRef, subscription, plan, budgetLimits: limitsByPlan.get(plan.id) ?? [] }] : [];
    });
  }

  async listPlanSubscriptionBudgetUsage(
    subscriptionIds: string[],
    targetUserId: string | null = null,
    at = nowIso(),
  ): Promise<PlanBudgetSourceView[]> {
    const ids = [...new Set(subscriptionIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const subscriptions = await this.rows<PlanSubscription>(
      `SELECT * FROM "plan_subscriptions" WHERE "id" = ANY($1::text[])`,
      [ids],
    );
    if (subscriptions.length === 0) return [];

    const planIds = [...new Set(subscriptions.map((subscription) => subscription.planId))];
    const plans = await this.rows<PlanDefinition>(
      `SELECT * FROM "plans" WHERE "id" = ANY($1::text[])`,
      [planIds],
    );
    const plansById = new Map(plans.map((plan) => [plan.id, plan]));
    const limitsByPlan = await this.listPlanBudgetLimitsForPlans(planIds);
    const modelRows = await this.rows<{ planId: string; exposedModel: string }>(
      `SELECT relation."plan_id" AS "planId", access_point."exposed_model" AS "exposedModel"
       FROM "plan_access_points" relation
       INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
       WHERE relation."plan_id" = ANY($1::text[]) AND access_point."status" = 'enabled'
       ORDER BY relation."plan_id" ASC, access_point."exposed_model" ASC`,
      [planIds],
    );
    const modelsByPlan = new Map<string, string[]>();
    for (const row of modelRows) {
      const models = modelsByPlan.get(row.planId) ?? [];
      if (models[models.length - 1] !== row.exposedModel) models.push(row.exposedModel);
      modelsByPlan.set(row.planId, models);
    }

    const usageContexts = subscriptions.map((subscription) => postgresPlanSubscriptionUsageContext(subscription, at));
    const targetUser = targetUserId ? await this.getUser(targetUserId) : undefined;
    const targetUserScopeRefs = targetUserId
      ? new Set(await this.listEffectiveSubscriptionScopesForUser(targetUserId))
      : new Set<ScopeRef>();
    const historicalConsumerSubscriptionIds = targetUserId
      ? new Set((await this.rows<{ subscriptionId: string }>(
        `SELECT DISTINCT billing_event."billing_subscription_id" AS "subscriptionId"
         FROM "billing_history_refs" billing_event
         INNER JOIN (${POSTGRES_REQUEST_IDENTITY_SOURCE}) request_log ON request_log."request_id" = billing_event."request_id"
         WHERE request_log."user_id" = $1 AND billing_event."billing_subscription_id" = ANY($2::text[])`,
        [targetUserId, ids],
      )).map((row) => row.subscriptionId))
      : new Set<string>();
    const windows = usageContexts.flatMap(({ subscription, usageReferenceAt, effectiveState }) => {
      if (!usageReferenceAt) return [];
      const targetEligible = Boolean(targetUserId && (
        targetUserScopeRefs.has(subscription.scopeRef as ScopeRef)
        || (effectiveState === "ended" && historicalConsumerSubscriptionIds.has(subscription.id))
      ));
      return (limitsByPlan.get(subscription.planId) ?? []).flatMap((limit, index) => {
        if (limit.limitScope === "user" && !targetEligible) return [];
        return [{
          subscription,
          limit,
          input: postgresBudgetUsageWindow(`${subscription.id}:${index}`, limit, subscription, usageReferenceAt),
        }];
      });
    });

    const eventRows = windows.length === 0 ? [] : await this.rows<PostgresBudgetEventRow>(
      `SELECT billing_event."billing_subscription_id" AS "subscriptionId",
              request_log."user_id" AS "userId", billing_event."occurred_at" AS "createdAt",
              billing_event."total_tokens" AS "totalTokens", billing_event."billable_amount" AS "billableAmount"
       FROM "billing_history_refs" billing_event
       INNER JOIN (${POSTGRES_REQUEST_IDENTITY_SOURCE}) request_log ON request_log."request_id" = billing_event."request_id"
       WHERE billing_event."billing_subscription_id" = ANY($1::text[])
         AND billing_event."occurred_at" >= $2
         AND billing_event."occurred_at" < $3
       ORDER BY billing_event."occurred_at" ASC, billing_event."billing_event_id" ASC`,
      [ids, windows.reduce((min, item) => item.input.start < min ? item.input.start : min, windows[0]!.input.start), windows.reduce((max, item) => item.input.end > max ? item.input.end : max, windows[0]!.input.end)],
    );
    const aggregatesByKey = new Map<string, { usedTokens: number; usedAmount: number }>();
    for (const window of windows) {
      const personal = window.limit.limitScope === "user";
      const included = eventRows.filter((row) => row.subscriptionId === window.subscription.id
        && row.createdAt >= window.input.start
        && row.createdAt < window.input.end
        && (!personal || row.userId === targetUserId));
      aggregatesByKey.set(window.input.key, {
        usedTokens: included.reduce((sum, row) => sum + row.totalTokens, 0),
        usedAmount: included.reduce((sum, row) => sum + row.billableAmount, 0),
      });
    }

    const continuityTargets = subscriptions.flatMap((subscription) => subscription.effectiveEnd ? [{
      planId: subscription.planId,
      scopeRef: subscription.scopeRef,
      effectiveStart: subscription.effectiveEnd,
    }] : []);
    const nextRows = continuityTargets.length === 0 ? [] : await this.rows<{ id: string; planId: string; scopeRef: string; effectiveStart: string }>(
      `WITH continuity_targets AS (
         SELECT "planId", "scopeRef", "effectiveStart"
         FROM jsonb_to_recordset($1::jsonb)
           AS target("planId" text, "scopeRef" text, "effectiveStart" text)
       )
       SELECT subscription."id", subscription."plan_id" AS "planId",
              subscription."scope_ref" AS "scopeRef", subscription."effective_start" AS "effectiveStart"
       FROM "plan_subscriptions" subscription
       INNER JOIN continuity_targets target
         ON target."planId" = subscription."plan_id"
        AND target."scopeRef" = subscription."scope_ref"
        AND target."effectiveStart" = subscription."effective_start"
       WHERE subscription."subscription_lifecycle" = 'active'
       ORDER BY subscription."effective_start" ASC, subscription."created_at" ASC, subscription."id" ASC`,
      [JSON.stringify(continuityTargets)],
    );

    return usageContexts.flatMap((context) => {
      const { subscription } = context;
      const plan = plansById.get(subscription.planId);
      if (!plan) return [];
      const subscriptionWindows = windows.filter((window) => window.subscription.id === subscription.id);
      const windowByLimitId = new Map(subscriptionWindows.map((window) => [window.limit.id, window]));
      const limits = (limitsByPlan.get(plan.id) ?? []).flatMap((limit): PlanBudgetSourceView["limits"][number][] => {
        if (limit.limitScope === "user" && !targetUserId) return [];
        if (limit.limitScope === "user" && !targetUserScopeRefs.has(subscription.scopeRef as ScopeRef)
          && !(context.effectiveState === "ended" && historicalConsumerSubscriptionIds.has(subscription.id))) return [];
        const item = windowByLimitId.get(limit.id);
        if (!item) {
          return [{
            limitScope: limit.limitScope,
            metric: limit.metric,
            windowType: limit.windowType,
            windowSeconds: limit.windowSeconds,
            periodStart: null,
            periodEnd: null,
            limitValue: limit.limitValue,
            usedValue: null,
            remainingValue: null,
            percentUsed: null,
            exhausted: null,
            targetUser: limit.limitScope === "user" && targetUserId ? { id: targetUserId, label: targetUser?.email ?? targetUserId } : null,
            nextResetAt: null,
          }];
        }
        const summary = aggregatesByKey.get(item.input.key) ?? { usedTokens: 0, usedAmount: 0 };
        const usedValue = limit.metric === "tokens" ? summary.usedTokens : summary.usedAmount;
        return [{
          limitScope: limit.limitScope,
          metric: limit.metric,
          windowType: limit.windowType,
          windowSeconds: limit.windowSeconds,
          periodStart: item.input.start,
          periodEnd: item.input.periodEnd,
          limitValue: limit.limitValue,
          usedValue,
          remainingValue: Math.max(0, limit.limitValue - usedValue),
          percentUsed: Math.max(0, (usedValue / limit.limitValue) * 100),
          exhausted: usedValue >= limit.limitValue,
          targetUser: limit.limitScope === "user" && targetUserId ? { id: targetUserId, label: targetUser?.email ?? targetUserId } : null,
          nextResetAt: context.usageMode === "current" ? item.input.nextResetAt : null,
        }];
      });
      const nextPeriodStart = subscription.effectiveEnd
        ? nextRows.find((candidate) => candidate.id !== subscription.id
          && candidate.planId === subscription.planId
          && candidate.scopeRef === subscription.scopeRef
          && candidate.effectiveStart === subscription.effectiveEnd)?.effectiveStart ?? null
        : null;
      return [{
        subscriptionId: subscription.id,
        planId: plan.id,
        planName: plan.name,
        planVersion: plan.version,
        billingMode: postgresPlanBillingMode(plan.billingMode),
        scopeRef: subscription.scopeRef as ScopeRef,
        subscriptionLifecycle: subscription.subscriptionLifecycle,
        effectiveState: context.effectiveState,
        source: subscription.source,
        priority: subscription.priority,
        effectiveStart: subscription.effectiveStart,
        effectiveEnd: subscription.effectiveEnd,
        usageMode: context.usageMode,
        usageReferenceAt: context.usageReferenceAt,
        applicableModels: modelsByPlan.get(plan.id) ?? [],
        limits,
        userLimitCount: (limitsByPlan.get(plan.id) ?? []).filter((limit) => limit.limitScope === "user").length,
        nextPeriodStart,
      }];
    }).sort((left, right) => left.scopeRef.localeCompare(right.scopeRef)
      || left.priority - right.priority
      || left.effectiveStart.localeCompare(right.effectiveStart)
      || left.subscriptionId.localeCompare(right.subscriptionId));
  }

  async listEffectiveUserModelPlanSourceModels(userId: string, restriction?: ApiKeyPlanSourceRestrictionDecision): Promise<Awaited<ReturnType<ApplicationOperationPort["listEffectiveUserModelPlanSourceModels"]>>> {
    const restrictionPredicate = planSourceRestrictionPredicate(restriction, 'subscription."plan_id"', 'subscription."scope_ref"', 3);
    const rows = await this.rows<{ exposedModel: string }>(
      `WITH scopes AS (
         SELECT 'global:'::text AS "scopeRef"
         UNION ALL SELECT 'user:' || $1
         UNION ALL
         SELECT 'team:' || membership."team_id"
         FROM "team_memberships" membership
         INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
         WHERE membership."user_id" = $1
           AND NOT EXISTS (
             SELECT 1 FROM "team_deletion_lifecycles" deletion
             WHERE deletion."team_id" = membership."team_id"
               AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
           )
       )
       SELECT DISTINCT access_point."exposed_model" AS "exposedModel"
       FROM scopes
       INNER JOIN "plan_subscriptions" subscription
         ON subscription."scope_ref" = scopes."scopeRef"
         AND subscription."subscription_lifecycle" = 'active'
         AND subscription."effective_start" <= $2
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)
         AND ${restrictionPredicate.sql}
       INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
       INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
       INNER JOIN "access_points" access_point
         ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
       ORDER BY "exposedModel" ASC`,
      [userId, nowIso(), ...restrictionPredicate.params],
    );
    return rows.map((row) => row.exposedModel);
  }

  async findFirstEffectiveUserModelPlanScopeOrder(userId: string, exposedModel: string): Promise<Awaited<ReturnType<ApplicationOperationPort["findFirstEffectiveUserModelPlanScopeOrder"]>>> {
    const source = await this.findFirstOrderedPlanSourceForUser(userId, exposedModel);
    return source?.order ?? null;
  }

  async listUserModelPlanScopeOrders(userId: string, exposedModel?: string): Promise<Awaited<ReturnType<ApplicationOperationPort["listUserModelPlanScopeOrders"]>>> {
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listUserModelPlanScopeOrders"]>>[number]>(
      `SELECT * FROM "user_model_plan_scope_orders"
       WHERE "user_id" = $1 AND ($2::text IS NULL OR "exposed_model" = $2)
       ORDER BY "exposed_model" ASC, "position" ASC, "id" ASC`,
      [userId, exposedModel ?? null],
    );
  }

  private async materializeDerivedPlanSourcePreferences(userId: string, exposedModel: string, at = nowIso()): Promise<void> {
    await this.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`access-order:${userId}:${exposedModel}`]);
    await this.query(
      `WITH scopes AS (
         SELECT 'global:'::text AS "scopeRef"
         UNION ALL SELECT 'user:' || $1
         UNION ALL
         SELECT 'team:' || membership."team_id"
         FROM "team_memberships" membership
         INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
         WHERE membership."user_id" = $1
           AND NOT EXISTS (
             SELECT 1 FROM "team_deletion_lifecycles" deletion
             WHERE deletion."team_id" = membership."team_id"
               AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
           )
       ), candidates AS (
         SELECT subscription."plan_id" AS "planId", subscription."scope_ref" AS "scopeRef",
           MIN(subscription."priority")::int AS "defaultPriority",
           MIN(subscription."effective_start") AS "defaultEffectiveStart",
           MIN(subscription."created_at") AS "defaultSourceCreatedAt",
           MIN(subscription."id") AS "defaultSourceId"
         FROM scopes
         INNER JOIN "plan_subscriptions" subscription
           ON subscription."scope_ref" = scopes."scopeRef" AND subscription."subscription_lifecycle" = 'active'
           AND subscription."effective_start" <= $3 AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $3)
         INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
         INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
         INNER JOIN "access_points" access_point
           ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled' AND access_point."exposed_model" = $2
         GROUP BY subscription."plan_id", subscription."scope_ref"
       ), missing AS (
         SELECT candidate.*, ROW_NUMBER() OVER (
           ORDER BY candidate."defaultPriority", candidate."planId", candidate."scopeRef"
         )::int AS "rank"
         FROM candidates candidate
         LEFT JOIN "user_model_plan_scope_orders" preference
           ON preference."user_id" = $1 AND preference."exposed_model" = $2
           AND preference."plan_id" = candidate."planId" AND preference."subscription_scope_ref" = candidate."scopeRef"
         WHERE preference."id" IS NULL
       ), base AS (
         SELECT COALESCE(MAX("position"), 0)::int AS "position"
         FROM "user_model_plan_scope_orders" WHERE "user_id" = $1 AND "exposed_model" = $2
       )
       INSERT INTO "user_model_plan_scope_orders"(
         "id", "user_id", "exposed_model", "plan_id", "subscription_scope_ref", "position",
         "default_priority", "default_effective_start", "default_source_created_at", "default_source_id", "created_at", "updated_at"
       )
       SELECT 'derived_order_' || md5($1 || chr(31) || $2 || chr(31) || missing."planId" || chr(31) || missing."scopeRef"),
         $1, $2, missing."planId", missing."scopeRef", base."position" + missing."rank" * 1024,
         missing."defaultPriority", missing."defaultEffectiveStart", missing."defaultSourceCreatedAt", missing."defaultSourceId", $3, $3
       FROM missing CROSS JOIN base
       ON CONFLICT ("user_id", "exposed_model", "plan_id", "subscription_scope_ref") DO NOTHING`,
      [userId, exposedModel, at],
    );
  }

  /** Returns only preference rows that still correspond to a current runtime source. */
  private async listCurrentDerivedPlanSourcePreferences(userId: string, exposedModel: string, at = nowIso()): Promise<Awaited<ReturnType<ApplicationOperationPort["listUserModelPlanScopeOrders"]>>> {
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listUserModelPlanScopeOrders"]>>[number]>(
      `WITH scopes AS (
         SELECT 'global:'::text AS "scopeRef"
         UNION ALL SELECT 'user:' || $1
         UNION ALL
         SELECT 'team:' || membership."team_id"
         FROM "team_memberships" membership
         INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
         WHERE membership."user_id" = $1
           AND NOT EXISTS (
             SELECT 1 FROM "team_deletion_lifecycles" deletion
             WHERE deletion."team_id" = membership."team_id"
               AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
           )
       )
       SELECT preference.*
       FROM "user_model_plan_scope_orders" preference
       WHERE preference."user_id" = $1 AND preference."exposed_model" = $2
         AND EXISTS (
           SELECT 1
           FROM scopes
           INNER JOIN "plan_subscriptions" subscription
             ON subscription."scope_ref" = scopes."scopeRef"
             AND subscription."plan_id" = preference."plan_id"
             AND subscription."subscription_lifecycle" = 'active'
             AND subscription."effective_start" <= $3
             AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $3)
           INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
           INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
           INNER JOIN "access_points" access_point
             ON access_point."id" = relation."access_point_id"
             AND access_point."status" = 'enabled' AND access_point."exposed_model" = $2
           WHERE subscription."scope_ref" = preference."subscription_scope_ref"
         )
       ORDER BY preference."position" ASC, preference."id" ASC`,
      [userId, exposedModel, at],
    );
  }

  async replaceUserModelPlanSourceOrder(userId: string, exposedModel: string, orderedPlanScopeIds: string[]): Promise<Awaited<ReturnType<ApplicationOperationPort["replaceUserModelPlanSourceOrder"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const at = nowIso();
      await transaction.materializeDerivedPlanSourcePreferences(userId, exposedModel, at);
      const current = await transaction.listCurrentDerivedPlanSourcePreferences(userId, exposedModel, at);
      if (current.length > 50) throw new RelayError("access_order_requires_relative_move", "Use relative moves for model groups with more than 50 sources", 409);
      if (orderedPlanScopeIds.length !== current.length || new Set(orderedPlanScopeIds).size !== current.length || current.some((row) => !orderedPlanScopeIds.includes(row.id))) {
        throw new RelayError("access_order_changed", "The model's available Plan sources changed; reload the order and try again", 409);
      }
      const updatedAt = nowIso();
      for (const [position, id] of orderedPlanScopeIds.entries()) {
        await transaction.query(
          `UPDATE "user_model_plan_scope_orders"
           SET "position" = $1, "updated_at" = $2
           WHERE "id" = $3 AND "user_id" = $4 AND "exposed_model" = $5`,
          [(position + 1) * 1_024, updatedAt, id, userId, exposedModel],
        );
      }
      return transaction.listCurrentDerivedPlanSourcePreferences(userId, exposedModel, at);
    });
  }

  async moveUserModelPlanSourceOrder(userId: string, exposedModel: string, orderId: string, placement: "before" | "after", anchorId: string | null): Promise<Awaited<ReturnType<ApplicationOperationPort["moveUserModelPlanSourceOrder"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const at = nowIso();
      await transaction.materializeDerivedPlanSourcePreferences(userId, exposedModel, at);
      const current = await transaction.listCurrentDerivedPlanSourcePreferences(userId, exposedModel, at);
      const moving = current.find((row) => row.id === orderId);
      if (!moving) throw new RelayError("access_order_source_not_found", "Access order source not found for this user and model", 404);
      if (anchorId === orderId) throw new RelayError("invalid_access_order_anchor", "anchorId cannot equal the moved source", 400);
      const anchor = anchorId ? current.find((row) => row.id === anchorId) : null;
      if (anchorId && !anchor) throw new RelayError("invalid_access_order_anchor", "anchorId must belong to the same user and model", 400);
      const ordered = current.filter((row) => row.id !== orderId);
      const anchorIndex = anchor ? ordered.findIndex((row) => row.id === anchor.id) : -1;
      const insertionIndex = anchor
        ? anchorIndex + (placement === "after" ? 1 : 0)
        : placement === "before" ? 0 : ordered.length;
      ordered.splice(insertionIndex, 0, moving);
      const previous = ordered[insertionIndex - 1] ?? null;
      const following = ordered[insertionIndex + 1] ?? null;
      const candidate = previous && following
        ? Math.floor((previous.position + following.position) / 2)
        : previous ? previous.position + 1_024
          : following ? following.position - 1_024 : 1_024;
      const updatedAt = nowIso();
      if (Number.isSafeInteger(candidate)
        && (!previous || candidate > previous.position)
        && (!following || candidate < following.position)) {
        await transaction.query(
          `UPDATE "user_model_plan_scope_orders" SET "position" = $1, "updated_at" = $2 WHERE "id" = $3 AND "user_id" = $4 AND "exposed_model" = $5`,
          [candidate, updatedAt, moving.id, userId, exposedModel],
        );
      } else {
        for (const [position, row] of ordered.entries()) {
          await transaction.query(
            `UPDATE "user_model_plan_scope_orders" SET "position" = $1, "updated_at" = $2 WHERE "id" = $3 AND "user_id" = $4 AND "exposed_model" = $5`,
            [(position + 1) * 1_024, updatedAt, row.id, userId, exposedModel],
          );
        }
      }
      return transaction.listCurrentDerivedPlanSourcePreferences(userId, exposedModel, at);
    });
  }

  async pageUserAccessOrder(
    userId: string,
    input: Parameters<ApplicationOperationPort["pageUserAccessOrder"]>[1] = {},
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserAccessOrder"]>>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const exposedModel = input.exposedModel?.trim().slice(0, 200) ?? "";
    const totalRow = await this.one<{ count: number }>(
      `WITH scopes AS (
         SELECT 'global:'::text AS "scopeRef" UNION ALL SELECT 'user:' || $1 UNION ALL
         SELECT 'team:' || membership."team_id" FROM "team_memberships" membership
         INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
         WHERE membership."user_id" = $1 AND NOT EXISTS (
           SELECT 1 FROM "team_deletion_lifecycles" deletion WHERE deletion."team_id" = membership."team_id"
             AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
         )
       )
       SELECT COUNT(*)::int AS "count" FROM (
         SELECT access_point."exposed_model", subscription."plan_id", subscription."scope_ref"
         FROM scopes INNER JOIN "plan_subscriptions" subscription ON subscription."scope_ref" = scopes."scopeRef"
           AND subscription."subscription_lifecycle" = 'active' AND subscription."effective_start" <= $3
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $3)
         INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
         INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
         INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
         WHERE $2 = '' OR access_point."exposed_model" = $2
         GROUP BY access_point."exposed_model", subscription."plan_id", subscription."scope_ref"
       ) candidates`,
      [userId, exposedModel, at],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_access_order_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const offset = (page - 1) * pageSize;
    type AccessOrderRow = {
      id: string;
      exposedModel: string;
      planId: string | null;
      planName: string;
      subscriptionScopeRef: ScopeRef | null;
      position: number;
      previousOrderId: string | null;
      nextOrderId: string | null;
      scopeEffective: number;
      currentSubscriptionId: string | null;
      subscriptionCount: number;
      accessPointId: string | null;
      accessPointName: string | null;
      accessPointDescription: string | null;
      accessPointApiFamily: string | null;
      accessPointCount: number;
    };
    const rows = await this.rows<AccessOrderRow>(
      `WITH scopes AS (
         SELECT 'global:'::text AS "scopeRef" UNION ALL SELECT 'user:' || $1 UNION ALL
         SELECT 'team:' || membership."team_id" FROM "team_memberships" membership
         INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
         WHERE membership."user_id" = $1 AND NOT EXISTS (
           SELECT 1 FROM "team_deletion_lifecycles" deletion WHERE deletion."team_id" = membership."team_id"
             AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
         )
       ), candidates AS (
         SELECT access_point."exposed_model", subscription."plan_id", subscription."scope_ref", MIN(subscription."priority")::int AS "default_priority"
         FROM scopes INNER JOIN "plan_subscriptions" subscription ON subscription."scope_ref" = scopes."scopeRef"
           AND subscription."subscription_lifecycle" = 'active' AND subscription."effective_start" <= $5
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $5)
         INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
         INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
         INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
         WHERE $2 = '' OR access_point."exposed_model" = $2
         GROUP BY access_point."exposed_model", subscription."plan_id", subscription."scope_ref"
       ), ranked_base AS (
         SELECT COALESCE(preference."id", 'derived_order_' || md5($1 || chr(31) || candidate."exposed_model" || chr(31) || candidate."plan_id" || chr(31) || candidate."scope_ref")) AS "id",
           candidate."exposed_model", candidate."plan_id", candidate."scope_ref" AS "subscription_scope_ref",
           CASE WHEN preference."id" IS NULL THEN 1 ELSE 0 END AS "preferenceMissing",
           preference."position" AS "preferencePosition", preference."id" AS "preferenceId", candidate."default_priority"
         FROM candidates candidate LEFT JOIN "user_model_plan_scope_orders" preference
           ON preference."user_id" = $1 AND preference."exposed_model" = candidate."exposed_model"
           AND preference."plan_id" = candidate."plan_id" AND preference."subscription_scope_ref" = candidate."scope_ref"
       ), ranked AS (
         SELECT ranked_base.*, ROW_NUMBER() OVER (ORDER BY "exposed_model", "preferenceMissing",
           "preferencePosition" NULLS LAST, "preferenceId" NULLS LAST, "default_priority", "plan_id", "subscription_scope_ref")::int AS "position",
           LAG("id") OVER (ORDER BY "exposed_model", "preferenceMissing", "preferencePosition" NULLS LAST,
             "preferenceId" NULLS LAST, "default_priority", "plan_id", "subscription_scope_ref") AS "previousOrderId",
           LEAD("id") OVER (ORDER BY "exposed_model", "preferenceMissing", "preferencePosition" NULLS LAST,
             "preferenceId" NULLS LAST, "default_priority", "plan_id", "subscription_scope_ref") AS "nextOrderId"
         FROM ranked_base
       ), projected AS (
         SELECT *, 1::int AS "scope_effective" FROM ranked
         ORDER BY "exposed_model" ASC, "position" ASC, "id" ASC LIMIT $3 OFFSET $4
       ),
       subscriptions AS (
         SELECT projected."id" AS "order_id", subscription."id",
           ROW_NUMBER() OVER (PARTITION BY projected."id" ORDER BY subscription."priority", subscription."effective_start", subscription."created_at", subscription."id") AS "row_number",
           COUNT(*) OVER (PARTITION BY projected."id") AS "item_count"
         FROM projected
         INNER JOIN "plan_subscriptions" subscription
           ON projected."scope_effective" = 1
           AND subscription."plan_id" = projected."plan_id"
           AND subscription."scope_ref" = projected."subscription_scope_ref"
           AND subscription."subscription_lifecycle" = 'active'
           AND subscription."effective_start" <= $5
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $5)
         INNER JOIN "plans" runtime_plan
           ON runtime_plan."id" = subscription."plan_id"
           AND runtime_plan."plan_status" IN ('enabled', 'closed')
       ),
       access_points_projected AS (
         SELECT projected."id" AS "order_id", access_point."id", access_point."name", access_point."description", access_point."api_family",
           ROW_NUMBER() OVER (PARTITION BY projected."id" ORDER BY access_point."priority", access_point."fallback_order", access_point."created_at", access_point."id") AS "row_number",
           COUNT(*) OVER (PARTITION BY projected."id") AS "item_count"
         FROM projected
         INNER JOIN "plan_access_points" relation ON projected."scope_effective" = 1 AND relation."plan_id" = projected."plan_id"
         INNER JOIN "access_points" access_point
           ON access_point."id" = relation."access_point_id"
           AND access_point."status" = 'enabled'
           AND access_point."exposed_model" = projected."exposed_model"
       )
      SELECT projected."id", projected."previousOrderId", projected."nextOrderId",
         projected."exposed_model" AS "exposedModel",
         CASE WHEN projected."scope_effective" = 1 THEN projected."plan_id" ELSE NULL END AS "planId",
         CASE WHEN projected."scope_effective" = 1 THEN COALESCE(plan."name", projected."plan_id") ELSE 'Unavailable source' END AS "planName",
         CASE WHEN projected."scope_effective" = 1 THEN projected."subscription_scope_ref" ELSE NULL END AS "subscriptionScopeRef",
         projected."position", projected."scope_effective" AS "scopeEffective",
         subscription."id" AS "currentSubscriptionId", COALESCE(subscription."item_count", 0) AS "subscriptionCount",
         access_point."id" AS "accessPointId", access_point."name" AS "accessPointName",
         access_point."description" AS "accessPointDescription",
         access_point."api_family" AS "accessPointApiFamily", COALESCE(access_point."item_count", 0) AS "accessPointCount"
       FROM projected
       LEFT JOIN "plans" plan ON projected."scope_effective" = 1 AND plan."id" = projected."plan_id"
       LEFT JOIN subscriptions subscription ON subscription."order_id" = projected."id" AND subscription."row_number" = 1
       LEFT JOIN access_points_projected access_point ON access_point."order_id" = projected."id" AND access_point."row_number" = 1
       ORDER BY projected."exposed_model" ASC, projected."position" ASC, projected."id" ASC`,
      [userId, exposedModel, pageSize, offset, at],
    );
    const items = rows.map((row) => {
      const configurationError = row.scopeEffective !== 1
        ? null
        : row.subscriptionCount > 1
          ? "overlapping_active_subscriptions" as const
          : row.subscriptionCount === 1 && row.accessPointCount > 1
            ? "multiple_entry_access_points" as const
            : row.subscriptionCount === 1 && row.accessPointCount === 0
              ? "entry_access_point_missing" as const
              : null;
      return {
        id: row.id,
        exposedModel: row.exposedModel,
        planId: row.planId,
        planName: row.planName,
        subscriptionScopeRef: row.subscriptionScopeRef,
        position: row.position,
        currentSubscriptionId: row.scopeEffective === 1 && row.subscriptionCount === 1 ? row.currentSubscriptionId : null,
        status: configurationError
          ? "invalid_configuration" as const
          : row.scopeEffective === 1 && row.subscriptionCount === 1 && row.accessPointCount === 1 ? "available" as const : "unavailable" as const,
        configurationError,
        accessPoint: row.scopeEffective === 1 && row.subscriptionCount === 1 && row.accessPointCount === 1 && row.accessPointId ? {
          id: row.accessPointId,
          name: row.accessPointName ?? row.accessPointId,
          description: row.accessPointDescription,
          exposedModel: row.exposedModel,
          apiFamily: row.accessPointApiFamily ?? "",
        } : null,
      };
    });
    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
      previousOrderId: rows[0]?.previousOrderId ?? null,
      nextOrderId: rows.at(-1)?.nextOrderId ?? null,
      mode: total > pageSize ? "relative" : "replace",
    };
  }

  async pageUserAccessOrderModels(
    userId: string,
    page = 1,
    requestedPageSize?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserAccessOrderModels"]>>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const at = nowIso();
    const cte = postgresUserAvailableModelDirectoryCte();
    const totalRow = await this.one<{ count: number }>(
      `${cte} SELECT COUNT(*)::int AS "count" FROM directory`,
      [userId, at],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_access_order_model_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageUserAccessOrderModels"]>>["items"][number]>(
      `${cte}
       SELECT "exposedModel", "sourceCount"::int AS "sourceCount" FROM directory
       ORDER BY "exposedModel" ASC LIMIT $3 OFFSET $4`,
      [userId, at, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageUserApiKeyDirectory(
    userId: string,
    input: Parameters<ApplicationOperationPort["pageUserApiKeyDirectory"]>[1] = {},
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserApiKeyDirectory"]>>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const requestedPage = normalizeDirectoryPage(input.page, 10_000);
    const cte = postgresUserApiKeyDirectoryCte();
    const filter = `WHERE $3 = '' OR strpos(lower("id"), $3) > 0 OR strpos(lower("name"), $3) > 0 OR strpos(lower("keyPrefix"), $3) > 0 OR strpos(lower("status"), $3) > 0`;
    const totalRow = await this.one<{ count: number }>(`${cte} SELECT COUNT(*) AS "count" FROM directory ${filter}`, [userId, at, query]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_api_key_directory_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(requestedPage, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageUserApiKeyDirectory"]>>["items"][number]>(
      `${cte}
       SELECT id, "userId", name, "keyPrefix", status, "createdAt", "budgetLimit", "budgetWindowType", "budgetWindowSeconds", "calculatedCost", "lastUsedAt"
       FROM directory ${filter}
       ORDER BY "createdAt" ASC, id ASC
       LIMIT $4 OFFSET $5`,
      [userId, at, query, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async getUserApiKeyDetail(userId: string, apiKeyId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getUserApiKeyDetail"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getUserApiKeyDetail"]>>>(
      `SELECT "id", "user_id" AS "userId", "name", "key_prefix" AS "keyPrefix", "status",
              "expires_at" AS "expiresAt", "revoked_at" AS "revokedAt", "created_at" AS "createdAt"
       FROM "api_keys" WHERE "id" = $1 AND "user_id" = $2`,
      [apiKeyId, userId],
    );
  }

  async getUserApiKeyDirectoryMetrics(
    userId: string,
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getUserApiKeyDirectoryMetrics"]>>> {
    const row = await this.one<{
      totalKeys: number;
      activeKeys: number;
      disabledKeys: number;
      peakUsagePercent: number;
    }>(
      `${postgresUserApiKeyDirectoryCte()}
       SELECT COUNT(*)::int AS "totalKeys",
              COALESCE(SUM(CASE WHEN lower("status") IN ('active', 'enabled', 'healthy') THEN 1 ELSE 0 END), 0)::int AS "activeKeys",
              COALESCE(SUM(CASE WHEN lower("status") IN ('disabled', 'paused') THEN 1 ELSE 0 END), 0)::int AS "disabledKeys",
              COALESCE(MAX(CASE
                WHEN "budgetLimit" IS NOT NULL AND "budgetLimit" > 0
                  THEN LEAST(100, ROUND("calculatedCost" * 100.0 / "budgetLimit"))
                ELSE 0
              END), 0)::int AS "peakUsagePercent"
       FROM directory`,
      [userId, at],
    );
    return {
      totalKeys: safePostgresInteger(row?.totalKeys ?? 0, "postgres_api_key_total_invalid"),
      activeKeys: safePostgresInteger(row?.activeKeys ?? 0, "postgres_api_key_active_invalid"),
      disabledKeys: safePostgresInteger(row?.disabledKeys ?? 0, "postgres_api_key_disabled_invalid"),
      peakUsagePercent: safePostgresInteger(row?.peakUsagePercent ?? 0, "postgres_api_key_peak_usage_invalid"),
    };
  }

  async pageUserAvailableModels(
    userId: string,
    input: Parameters<ApplicationOperationPort["pageUserAvailableModels"]>[1] = {},
    at = nowIso(),
    restriction?: ApiKeyPlanSourceRestrictionDecision,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageUserAvailableModels"]>>> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const requestedPage = normalizeDirectoryPage(input.page, 10_000);
    const restrictionPredicate = planSourceRestrictionPredicate(restriction, 'subscription."plan_id"', 'subscription."scope_ref"', 3);
    const cte = postgresUserAvailableModelDirectoryCte(restrictionPredicate.sql);
    const queryParameter = 3 + restrictionPredicate.params.length;
    const filter = `WHERE $${queryParameter} = '' OR strpos(lower("accessPointId"), $${queryParameter}) > 0 OR strpos(lower("displayName"), $${queryParameter}) > 0 OR strpos(lower("apiFamily"), $${queryParameter}) > 0 OR strpos(lower("exposedModel"), $${queryParameter}) > 0 OR strpos(lower("planId"), $${queryParameter}) > 0 OR strpos(lower("planName"), $${queryParameter}) > 0`;
    const totalRow = await this.one<{ count: number }>(`${cte} SELECT COUNT(*) AS "count" FROM directory ${filter}`, [userId, at, ...restrictionPredicate.params, query]);
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_available_model_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(requestedPage, totalPages);
    type DirectoryRow = {
      accessPointId: string;
      displayName: string;
      description: string | null;
      apiFamily: string;
      exposedModel: string;
      subscriptionScopeRef: ScopeRef;
      planId: string;
      planName: string;
      subscriptionId: string;
    };
    const rows = await this.rows<DirectoryRow>(
      `${cte}
       SELECT "accessPointId", "displayName", "description", "apiFamily", "exposedModel", "subscriptionScopeRef", "planId", "planName", "subscriptionId"
       FROM directory ${filter}
       ORDER BY lower("exposedModel") ASC, "accessPointId" ASC
       LIMIT $${queryParameter + 1} OFFSET $${queryParameter + 2}`,
      [userId, at, ...restrictionPredicate.params, query, pageSize, (page - 1) * pageSize],
    );
    const items = await Promise.all(rows.map(async (row) => {
      const effective = await this.findEffectivePlanAccessPointPrice(row.planId, row.accessPointId);
      return {
        ...row,
        effectivePrice: effective
          ? {
            source: effective.source,
            price: { ...effective.price, tiers: effective.price.tiers ?? [] },
            basePrice: effective.basePrice ? { ...effective.basePrice, tiers: effective.basePrice.tiers ?? [] } : null,
            planAccessPointPrice: effective.planAccessPointPrice ? { ...effective.planAccessPointPrice, tiers: effective.planAccessPointPrice.tiers ?? [] } : null,
          }
          : null,
      };
    }));
    return { items, page, pageSize, total, totalPages };
  }

  async getAgentCatalogRevision(userId: string, at: string, providerBaseUrl: string): Promise<string> {
    const row = await this.one<{ generation: number; temporalEpoch: string | null }>(
      `SELECT revision AS "generation",
              (SELECT MAX(boundary) FROM (
                SELECT "effective_start" AS boundary FROM "plan_subscriptions" WHERE "effective_start" <= $1
                UNION ALL
                SELECT "effective_end" AS boundary FROM "plan_subscriptions" WHERE "effective_end" IS NOT NULL AND "effective_end" <= $1
              ) AS boundaries) AS "temporalEpoch"
       FROM "agent_catalog_revisions" WHERE "id" = 1`,
      [at],
    );
    if (!row) throw new RelayError("agent_catalog_revision_not_found", "Agent catalog revision is not initialized", 500);
    return createHash("sha256")
      .update(JSON.stringify({ userId, providerBaseUrl, ...row }))
      .digest("base64url");
  }

  async getUserAvailableModelMetrics(
    userId: string,
    at = nowIso(),
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getUserAvailableModelMetrics"]>>> {
    const row = await this.one<{ totalModels: number; apiFamilyCount: number }>(
      `${postgresUserAvailableModelDirectoryCte()}
       SELECT COUNT(*)::int AS "totalModels", COUNT(DISTINCT "apiFamily")::int AS "apiFamilyCount"
       FROM directory`,
      [userId, at],
    );
    return {
      totalModels: safePostgresInteger(row?.totalModels ?? 0, "postgres_available_model_total_invalid"),
      apiFamilyCount: safePostgresInteger(row?.apiFamilyCount ?? 0, "postgres_available_model_family_count_invalid"),
    };
  }

  async listPlanBudgetLimitsForPlans(planIds: string[]): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanBudgetLimitsForPlans"]>>> {
    const result: Awaited<ReturnType<ApplicationOperationPort["listPlanBudgetLimitsForPlans"]>> = new Map(planIds.map((planId) => [planId, []]));
    const uniqueIds = [...new Set(planIds)];
    if (uniqueIds.length === 0) return result;
    const rows = await this.rows<{
      id: string;
      planId: string;
      limitScope: string;
      metric: string;
      limitValue: number;
      windowType: string;
      windowSeconds: number | null;
      createdAt: string;
    }>(
      `SELECT * FROM "plan_budget_limits"
       WHERE "plan_id" = ANY($1::text[])
       ORDER BY "plan_id" ASC,
         CASE "limit_scope" WHEN 'subscription' THEN 0 ELSE 1 END,
         "metric" ASC, "window_type" ASC, COALESCE("window_seconds", -1),
         "limit_value" ASC, "created_at" ASC, "id" ASC`,
      [uniqueIds],
    );
    for (const row of rows) {
      const limit = {
        ...row,
        windowType: row.windowType as "fixed" | "cumulative",
      } as Awaited<ReturnType<ApplicationOperationPort["listPlanBudgetLimits"]>>[number];
      result.get(row.planId)?.push(limit);
    }
    for (const limits of result.values()) {
      limits.sort((left, right) =>
        (left.limitScope === right.limitScope ? 0 : left.limitScope === "subscription" ? -1 : 1)
        || left.metric.localeCompare(right.metric)
        || left.windowType.localeCompare(right.windowType)
        || (left.windowSeconds ?? -1) - (right.windowSeconds ?? -1)
        || left.limitValue - right.limitValue
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id));
    }
    return result;
  }

  async listPlanBudgetLimits(planId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["listPlanBudgetLimits"]>>> {
    return (await this.listPlanBudgetLimitsForPlans([planId])).get(planId) ?? [];
  }

  async listScopeBudgetPolicyAssignments(scopeRef?: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["listScopeBudgetPolicyAssignments"]>>> {
    const params = scopeRef === undefined ? [] : [scopeRef];
    const rows = await this.rows<{
      id: string;
      scopeRef: ScopeRef;
      budgetPolicyId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      policyId: string;
      policyMetric: string;
      policyLimitValue: number;
      policyWindowType: string;
      policyWindowSeconds: number | null;
      policyStatus: string;
      policyCreatedAt: string;
      policyUpdatedAt: string;
    }>(
      `SELECT assignment."id", assignment."scope_ref", assignment."budget_policy_id", assignment."status",
              assignment."created_at", assignment."updated_at",
              policy."id" AS "policy_id", policy."metric" AS "policy_metric",
              policy."limit_value" AS "policy_limit_value", policy."window_type" AS "policy_window_type",
              policy."window_seconds" AS "policy_window_seconds", policy."status" AS "policy_status",
              policy."created_at" AS "policy_created_at", policy."updated_at" AS "policy_updated_at"
       FROM "scope_budget_policies" assignment
       INNER JOIN "budget_policies" policy ON policy."id" = assignment."budget_policy_id"
       ${scopeRef === undefined ? "" : "WHERE assignment.\"scope_ref\" = $1"}
       ORDER BY assignment."created_at" ASC, assignment."id" ASC`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      scopeRef: row.scopeRef,
      budgetPolicyId: row.budgetPolicyId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      budgetPolicy: {
        id: row.policyId,
        metric: row.policyMetric,
        limitValue: row.policyLimitValue,
        windowType: row.policyWindowType,
        windowSeconds: row.policyWindowSeconds,
        status: row.policyStatus,
        createdAt: row.policyCreatedAt,
        updatedAt: row.policyUpdatedAt,
      },
    })) as Awaited<ReturnType<ApplicationOperationPort["listScopeBudgetPolicyAssignments"]>>;
  }

  async listScopeGovernanceBudgetPolicyAssignments(scopeRef?: ScopeRef | readonly ScopeRef[]): Promise<Awaited<ReturnType<ApplicationOperationPort["listScopeGovernanceBudgetPolicyAssignments"]>>> {
    const scopeRefs = scopeRef === undefined ? undefined : Array.isArray(scopeRef) ? [...new Set(scopeRef)] : [scopeRef];
    const params = scopeRefs === undefined ? [] : [scopeRefs];
    const scopePredicate = scopeRefs === undefined ? "" : `WHERE assignment."scope_ref" = ANY($1::text[])`;
    const rows = await this.rows<{
      id: string;
      scopeRef: ScopeRef;
      governanceBudgetPolicyId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      policyId: string;
      policyMetric: string;
      policyLimitValue: number;
      policyWindowType: string;
      policyWindowSeconds: number | null;
      policyStatus: string;
      policyCreatedAt: string;
      policyUpdatedAt: string;
    }>(
      `SELECT assignment."id", assignment."scope_ref", assignment."governance_budget_policy_id", assignment."status",
              assignment."created_at", assignment."updated_at",
              policy."id" AS "policy_id", policy."metric" AS "policy_metric",
              policy."limit_value" AS "policy_limit_value", policy."window_type" AS "policy_window_type",
              policy."window_seconds" AS "policy_window_seconds", policy."status" AS "policy_status",
              policy."created_at" AS "policy_created_at", policy."updated_at" AS "policy_updated_at"
       FROM "scope_governance_budget_policies" assignment
       INNER JOIN "governance_budget_policies" policy ON policy."id" = assignment."governance_budget_policy_id"
       ${scopePredicate}
       ORDER BY assignment."created_at" ASC, assignment."id" ASC`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      scopeRef: row.scopeRef,
      governanceBudgetPolicyId: row.governanceBudgetPolicyId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      governanceBudgetPolicy: {
        id: row.policyId,
        metric: row.policyMetric,
        limitValue: row.policyLimitValue,
        windowType: row.policyWindowType,
        windowSeconds: row.policyWindowSeconds,
        status: row.policyStatus,
        createdAt: row.policyCreatedAt,
        updatedAt: row.policyUpdatedAt,
      },
    })) as Awaited<ReturnType<ApplicationOperationPort["listScopeGovernanceBudgetPolicyAssignments"]>>;
  }

  async listScopeRateLimitPolicyAssignments(scopeRef?: ScopeRef | readonly ScopeRef[]): Promise<Awaited<ReturnType<ApplicationOperationPort["listScopeRateLimitPolicyAssignments"]>>> {
    const scopeRefs = scopeRef === undefined ? undefined : Array.isArray(scopeRef) ? [...new Set(scopeRef)] : [scopeRef];
    const params = scopeRefs === undefined ? [] : [scopeRefs];
    const scopePredicate = scopeRefs === undefined ? "" : `WHERE assignment."scope_ref" = ANY($1::text[])`;
    const rows = await this.rows<{
      id: string;
      scopeRef: ScopeRef;
      rateLimitPolicyId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      policyId: string;
      policyMetric: string;
      policyLimitValue: number;
      policyWindowSeconds: number;
      policyBurstValue: number;
      policyMode: string;
      policyStatus: string;
      policyCreatedAt: string;
    }>(
      `SELECT assignment."id", assignment."scope_ref", assignment."rate_limit_policy_id", assignment."status",
              assignment."created_at", assignment."updated_at",
              policy."id" AS "policy_id", policy."metric" AS "policy_metric",
              policy."limit_value" AS "policy_limit_value", policy."window_seconds" AS "policy_window_seconds",
              policy."burst_value" AS "policy_burst_value", policy."mode" AS "policy_mode",
              policy."status" AS "policy_status", policy."created_at" AS "policy_created_at"
       FROM "scope_rate_limit_policies" assignment
       INNER JOIN "rate_limit_policies" policy ON policy."id" = assignment."rate_limit_policy_id"
       ${scopePredicate}
       ORDER BY assignment."created_at" ASC, assignment."id" ASC`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      scopeRef: row.scopeRef,
      rateLimitPolicyId: row.rateLimitPolicyId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      rateLimitPolicy: {
        id: row.policyId,
        metric: row.policyMetric,
        limitValue: row.policyLimitValue,
        windowSeconds: row.policyWindowSeconds,
        burstValue: row.policyBurstValue,
        mode: row.policyMode,
        status: row.policyStatus,
        createdAt: row.policyCreatedAt,
      },
    })) as Awaited<ReturnType<ApplicationOperationPort["listScopeRateLimitPolicyAssignments"]>>;
  }

  async pageOrderedPlanSourcesForUser(
    userId: string,
    exposedModel: string,
    cursor: Parameters<ApplicationOperationPort["pageOrderedPlanSourcesForUser"]>[2] = null,
    at = nowIso(),
    restriction?: ApiKeyPlanSourceRestrictionDecision,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageOrderedPlanSourcesForUser"]>>> {
    type DerivedOrderRow = {
      orderId: string | null;
      orderPosition: number | null;
      orderCreatedAt: string | null;
      orderUpdatedAt: string | null;
      planId: string;
      subscriptionScopeRef: ScopeRef;
      defaultPriority: number;
      defaultEffectiveStart: string;
      defaultSourceCreatedAt: string;
      defaultSourceId: string;
      position: number;
    };
    const restrictionPredicate = planSourceRestrictionPredicate(restriction, 'subscription."plan_id"', 'subscription."scope_ref"', 5);
    const derived = await this.rows<DerivedOrderRow>(
      `WITH scopes AS (
         SELECT 'global:'::text AS "scopeRef"
         UNION ALL SELECT 'user:' || $1
         UNION ALL
         SELECT 'team:' || membership."team_id"
         FROM "team_memberships" membership
         INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
         WHERE membership."user_id" = $1
           AND NOT EXISTS (
             SELECT 1 FROM "team_deletion_lifecycles" deletion
             WHERE deletion."team_id" = membership."team_id"
               AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
           )
       ), candidates AS (
         SELECT subscription."plan_id" AS "planId", subscription."scope_ref" AS "subscriptionScopeRef",
           MIN(subscription."priority")::int AS "defaultPriority",
           MIN(subscription."effective_start") AS "defaultEffectiveStart",
           MIN(subscription."created_at") AS "defaultSourceCreatedAt",
           MIN(subscription."id") AS "defaultSourceId"
         FROM scopes
         INNER JOIN "plan_subscriptions" subscription
           ON subscription."scope_ref" = scopes."scopeRef"
           AND subscription."subscription_lifecycle" = 'active'
           AND subscription."effective_start" <= $3
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $3)
         INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
         INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
         INNER JOIN "access_points" access_point
           ON access_point."id" = relation."access_point_id"
           AND access_point."status" = 'enabled' AND access_point."exposed_model" = $2
           AND ${restrictionPredicate.sql}
         GROUP BY subscription."plan_id", subscription."scope_ref"
       ), ranked AS (
         SELECT candidate.*, preference."id" AS "orderId", preference."position" AS "orderPosition",
           preference."created_at" AS "orderCreatedAt", preference."updated_at" AS "orderUpdatedAt",
           ROW_NUMBER() OVER (
             ORDER BY CASE WHEN preference."id" IS NULL THEN 1 ELSE 0 END,
               preference."position" ASC NULLS LAST, preference."id" ASC NULLS LAST,
               candidate."defaultPriority" ASC, candidate."planId" ASC, candidate."subscriptionScopeRef" ASC
           )::int AS "position"
         FROM candidates candidate
         LEFT JOIN "user_model_plan_scope_orders" preference
           ON preference."user_id" = $1 AND preference."exposed_model" = $2
           AND preference."plan_id" = candidate."planId"
           AND preference."subscription_scope_ref" = candidate."subscriptionScopeRef"
       )
       SELECT * FROM ranked
       WHERE $4::integer IS NULL OR "position" > $4
       ORDER BY "position" ASC
       LIMIT 51`,
      [userId, exposedModel, at, cursor?.position ?? null, ...restrictionPredicate.params],
    );
    const orders = derived.map((row) => ({
      id: row.orderId ?? postgresDerivedPlanSourceOrderId(userId, exposedModel, row.planId, row.subscriptionScopeRef),
      userId,
      exposedModel,
      planId: row.planId,
      subscriptionScopeRef: row.subscriptionScopeRef,
      position: row.position,
      defaultPriority: row.defaultPriority,
      defaultEffectiveStart: row.defaultEffectiveStart,
      defaultSourceCreatedAt: row.defaultSourceCreatedAt,
      defaultSourceId: row.defaultSourceId,
      createdAt: row.orderCreatedAt ?? row.defaultSourceCreatedAt,
      updatedAt: row.orderUpdatedAt ?? row.defaultSourceCreatedAt,
    })) as Awaited<ReturnType<ApplicationOperationPort["listUserModelPlanScopeOrders"]>>;
    const pageOrders = orders.slice(0, 50);
    if (pageOrders.length === 0) return { items: [], nextCursor: null };
    const planIds = [...new Set(pageOrders.map((order) => order.planId))];
    const pageOrderJson = JSON.stringify(pageOrders.map((order) => ({ planId: order.planId, scopeRef: order.subscriptionScopeRef })));
    const [plans, subscriptions, accessPoints] = await Promise.all([
      this.rows<PlanDefinition>(`SELECT * FROM "plans" WHERE "id" = ANY($1::text[])`, [planIds]),
      this.rows<Awaited<ReturnType<ApplicationOperationPort["findActivePlanSubscriptions"]>>[number]>(
        `WITH page_orders AS (
           SELECT "planId", "scopeRef"
           FROM jsonb_to_recordset($2::jsonb)
             AS page_order("planId" text, "scopeRef" text)
         )
         SELECT subscription.*
         FROM "plan_subscriptions" subscription
         INNER JOIN page_orders page_order
           ON page_order."planId" = subscription."plan_id"
          AND page_order."scopeRef" = subscription."scope_ref"
         WHERE subscription."subscription_lifecycle" = 'active'
           AND subscription."effective_start" <= $1
           AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $1)
         ORDER BY subscription."plan_id" ASC, subscription."scope_ref" ASC,
                  subscription."priority" ASC, subscription."effective_start" ASC,
                  subscription."created_at" ASC, subscription."id" ASC`,
        [at, pageOrderJson],
      ),
      this.rows<Awaited<ReturnType<ApplicationOperationPort["listAccessPoints"]>>[number] & { planId: string }>(
        `SELECT access_point.*, relation."plan_id"
         FROM "plan_access_points" relation
         INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
         WHERE relation."plan_id" = ANY($1::text[])
           AND access_point."status" = 'enabled'
           AND access_point."exposed_model" = $2
         ORDER BY relation."plan_id" ASC, access_point."priority" ASC,
                  access_point."fallback_order" ASC, access_point."created_at" ASC,
                  access_point."id" ASC`,
        [planIds, exposedModel],
      ),
    ]);
    const plansById = new Map(plans.map((plan) => [plan.id, plan]));
    const items = pageOrders.flatMap((order) => {
      const plan = plansById.get(order.planId);
      if (!plan || !["enabled", "closed"].includes(plan.planStatus)) return [];
      const currentSubscriptions = subscriptions.filter((subscription) => subscription.planId === order.planId && subscription.scopeRef === order.subscriptionScopeRef);
      const currentAccessPoints = accessPoints.filter((accessPoint) => accessPoint.planId === order.planId);
      const subscription = currentSubscriptions[0] ?? null;
      const configurationError = currentSubscriptions.length > 1
        ? "overlapping_active_subscriptions" as const
        : subscription && currentAccessPoints.length > 1
          ? "multiple_entry_access_points" as const
          : subscription && currentAccessPoints.length === 0
            ? "entry_access_point_missing" as const
            : null;
      return [{ order, subscription, plan, accessPoint: currentAccessPoints[0] ?? null, configurationError }];
    });
    const boundary = pageOrders.at(-1)!;
    return {
      items,
      nextCursor: orders.length > 50 ? { position: boundary.position, id: boundary.id } : null,
    };
  }

  async findFirstOrderedPlanSourceForUser(userId: string, exposedModel: string, at = nowIso(), restriction?: ApiKeyPlanSourceRestrictionDecision): Promise<Awaited<ReturnType<ApplicationOperationPort["findFirstOrderedPlanSourceForUser"]>>> {
    let cursor: Parameters<ApplicationOperationPort["pageOrderedPlanSourcesForUser"]>[2] = null;
    do {
      const page = await this.pageOrderedPlanSourcesForUser(userId, exposedModel, cursor, at, restriction);
      for (const source of page.items) {
        if (!source.subscription) continue;
        assertOrderedPlanSourceConfiguration(source);
        if (!source.accessPoint) continue;
        return source;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }

  async getRequestCaptureSetting(): Promise<RequestCaptureSetting> {
    const row = await this.one<RequestCaptureSetting>(`SELECT * FROM "request_capture_settings" WHERE "id" = 'global'`, []);
    return row ?? { id: "global", enabled: true, updatedBy: null, createdAt: "", updatedAt: "" };
  }

  async setRequestCaptureEnabled(enabled: boolean, updatedBy?: string | null): Promise<RequestCaptureSetting> {
    const now = nowIso();
    const existing = await this.getRequestCaptureSetting();
    return this.upsertRow<RequestCaptureSetting>("request_capture_settings", {
      id: "global", enabled, updatedBy: updatedBy ?? null, createdAt: existing.createdAt || now, updatedAt: now,
    }, ["id"], ["enabled", "updatedBy", "updatedAt"]);
  }

  async getPipelinePluginSetting(pluginId: string, scopeRef: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["getPipelinePluginSetting"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getPipelinePluginSetting"]>>>(
      `SELECT * FROM "pipeline_plugin_settings" WHERE "plugin_id" = $1 AND "scope_ref" = $2`,
      [pluginId, scopeRef],
    );
  }

  async upsertPipelinePluginSetting(input: { id?: string; pluginId: string; scopeRef: ScopeRef; enabled: boolean; configJson: string; updatedByUserId?: string | null; now?: string }): Promise<PipelinePluginSetting> {
    const timestamp = input.now ?? nowIso();
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.one<PipelinePluginSetting>(
        `SELECT * FROM "pipeline_plugin_settings" WHERE "plugin_id" = $1 AND "scope_ref" = $2 FOR UPDATE`,
        [input.pluginId, input.scopeRef],
      );
      if (existing) {
        const updated = await transaction.query<PipelinePluginSetting>(
          `UPDATE "pipeline_plugin_settings"
           SET "enabled" = $2, "config_json" = $3, "setting_revision" = $4, "config_revision" = $5,
               "updated_by_user_id" = $6, "updated_at" = $7
           WHERE "id" = $1 RETURNING *`,
          [existing.id, input.enabled, input.configJson, existing.settingRevision + 1, existing.configJson === input.configJson ? existing.configRevision : existing.configRevision + 1, input.updatedByUserId ?? null, timestamp],
        );
        if (!updated.rows[0]) throw new Error("postgres_pipeline_plugin_setting_update_empty");
        return mapPostgresRow<PipelinePluginSetting>(updated.rows[0]);
      }
      return transaction.insertRow<PipelinePluginSetting>("pipeline_plugin_settings", {
        id: input.id ?? createId("pps"), pluginId: input.pluginId, scopeRef: input.scopeRef, enabled: input.enabled,
        configJson: input.configJson, settingRevision: 1, configRevision: 1, updatedByUserId: input.updatedByUserId ?? null,
        createdAt: timestamp, updatedAt: timestamp,
      });
    });
  }

  async getIngressPluginSetting(pluginId: string, scopeRef: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["getIngressPluginSetting"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getIngressPluginSetting"]>>>(
      `SELECT * FROM "ingress_plugin_settings" WHERE "plugin_id" = $1 AND "scope_ref" = $2`,
      [pluginId, scopeRef],
    );
  }

  async upsertIngressPluginSetting(input: { id?: string; pluginId: string; scopeRef: ScopeRef; enabled: boolean; configJson: string; updatedByUserId?: string | null; now?: string }): Promise<IngressPluginSetting> {
    const timestamp = input.now ?? nowIso();
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.one<IngressPluginSetting>(
        `SELECT * FROM "ingress_plugin_settings" WHERE "plugin_id" = $1 AND "scope_ref" = $2 FOR UPDATE`,
        [input.pluginId, input.scopeRef],
      );
      if (existing) {
        const updated = await transaction.query<IngressPluginSetting>(
          `UPDATE "ingress_plugin_settings"
           SET "enabled" = $2, "config_json" = $3, "updated_by_user_id" = $4, "updated_at" = $5
           WHERE "id" = $1 RETURNING *`,
          [existing.id, input.enabled, input.configJson, input.updatedByUserId ?? null, timestamp],
        );
        if (!updated.rows[0]) throw new Error("postgres_ingress_plugin_setting_update_empty");
        return mapPostgresRow<IngressPluginSetting>(updated.rows[0]);
      }
      return transaction.insertRow<IngressPluginSetting>("ingress_plugin_settings", {
        id: input.id ?? createId("ips"), pluginId: input.pluginId, scopeRef: input.scopeRef, enabled: input.enabled,
        configJson: input.configJson, updatedByUserId: input.updatedByUserId ?? null, createdAt: timestamp, updatedAt: timestamp,
      });
    });
  }

  async isRequestCaptureEnabled(): Promise<boolean> {
    return (await this.getRequestCaptureSetting()).enabled;
  }

  async listPipelinePluginSettings(scopeRefs?: ScopeRef[]): Promise<Awaited<ReturnType<ApplicationOperationPort["listPipelinePluginSettings"]>>> {
    if (scopeRefs?.length === 0) return [];
    if (scopeRefs === undefined) {
      return this.rows<Awaited<ReturnType<ApplicationOperationPort["listPipelinePluginSettings"]>>[number]>(
        `SELECT * FROM "pipeline_plugin_settings" ORDER BY "plugin_id" ASC, "scope_ref" ASC`,
      );
    }
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listPipelinePluginSettings"]>>[number]>(
      `SELECT * FROM "pipeline_plugin_settings" WHERE "scope_ref" = ANY($1::text[]) ORDER BY "plugin_id" ASC, "scope_ref" ASC`,
      [scopeRefs],
    );
  }

  async listIngressPluginSettings(scopeRefs?: ScopeRef[]): Promise<Awaited<ReturnType<ApplicationOperationPort["listIngressPluginSettings"]>>> {
    if (scopeRefs?.length === 0) return [];
    if (scopeRefs === undefined) {
      return this.rows<Awaited<ReturnType<ApplicationOperationPort["listIngressPluginSettings"]>>[number]>(
        `SELECT * FROM "ingress_plugin_settings" ORDER BY "plugin_id" ASC, "scope_ref" ASC`,
      );
    }
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listIngressPluginSettings"]>>[number]>(
      `SELECT * FROM "ingress_plugin_settings" WHERE "scope_ref" = ANY($1::text[]) ORDER BY "plugin_id" ASC, "scope_ref" ASC`,
      [scopeRefs],
    );
  }

  async getCreditAccount(id: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getCreditAccount"]>>> {
    type CreditAccountRow = Exclude<Awaited<ReturnType<ApplicationOperationPort["getCreditAccount"]>>, undefined>;
    return this.one<CreditAccountRow>(`SELECT * FROM "credit_accounts" WHERE "id" = $1`, [id]);
  }

  async createCreditAccount(input: Parameters<ApplicationOperationPort["createCreditAccount"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createCreditAccount"]>>> {
    const now = nowIso();
    const row = {
      id: input.id ?? createId("credit_account"),
      scopeRef: input.scopeRef,
      status: input.status ?? "active",
      balanceSnapUnits: input.balanceSnapUnits ?? 0,
      balanceSnapLedgerEventId: input.balanceSnapLedgerEventId ?? null,
      balanceSnapUpdatedAt: input.balanceSnapUpdatedAt ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    await this.query(
      `INSERT INTO "credit_accounts"
        ("id", "scope_ref", "status", "balance_snap_units", "balance_snap_ledger_event_id", "balance_snap_updated_at", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ("scope_ref") DO NOTHING`,
      [row.id, row.scopeRef, row.status, row.balanceSnapUnits, row.balanceSnapLedgerEventId, row.balanceSnapUpdatedAt, row.createdAt, row.updatedAt],
    );
    const account = await this.findCreditAccountForScope(row.scopeRef as ScopeRef);
    if (!account) throw new RelayError("credit_account_not_found", "Credit account could not be created", 500);
    return account;
  }

  async findCreditAccountForScope(scopeRef: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["findCreditAccountForScope"]>>> {
    type CreditAccountRow = Exclude<Awaited<ReturnType<ApplicationOperationPort["getCreditAccount"]>>, undefined>;
    return this.one<CreditAccountRow>(
      `SELECT * FROM "credit_accounts" WHERE "scope_ref" = $1 AND "status" = 'active'`,
      [scopeRef],
    );
  }

  async getCreditAccountBalanceUnits(accountId: string): Promise<number> {
    const account = await this.getCreditAccount(accountId);
    return account?.balanceSnapUnits ?? 0;
  }

  async getCreditAccountBalance(accountId: string): Promise<number> {
    const units = await this.getCreditAccountBalanceUnits(accountId);
    if (!Number.isSafeInteger(units)) throw new RelayError("invalid_credit_units", "Credit units must be a safe integer", 400);
    return units / 1_000_000;
  }

  async getCreditProduct(id: string): Promise<CreditProduct | undefined> {
    return this.one<CreditProduct>(`SELECT * FROM "credit_products" WHERE "id" = $1`, [id]);
  }

  async getCreditProductListing(id: string): Promise<CreditProductListing | undefined> {
    return this.one<CreditProductListing>(`SELECT * FROM "credit_product_listings" WHERE "id" = $1`, [id]);
  }

  async getCard(id: string): Promise<Card | undefined> {
    return this.one<Card>(`SELECT * FROM "cards" WHERE "id" = $1`, [id]);
  }

  async createCardActivationBatch(input: Parameters<ApplicationOperationPort["createCardActivationBatch"]>[0]): Promise<CardActivationBatch> {
    return this.withRetriedTransaction(async (transaction) => {
      const referenceCode = postgresNormalizeCardActivationReference(input.referenceCode);
      const quantity = postgresNormalizeCardActivationQuantity(input.quantity);
      const redeemExpiresAt = postgresNormalizeCardActivationExpiry(input.redeemExpiresAt);
      const idempotencyKey = postgresRequiredCardActivationValue(input.idempotencyKey, "Idempotency-Key");
      const planId = input.planId ?? null;
      const creditProductId = input.creditProductId ?? null;
      const creditAmountUnits = input.creditAmountUnits ?? null;
      const requestHash = postgresSha256Text(JSON.stringify({ referenceCode, cardType: input.cardType, planId, creditProductId, creditAmountUnits, quantity, redeemExpiresAt }));
      const idempotencyKeyHash = postgresSha256Text(idempotencyKey);
      const existing = await transaction.one<CardActivationBatch>(
        `SELECT * FROM "card_activation_batches" WHERE "created_by_user_id" = $1 AND "idempotency_key_hash" = $2`,
        [input.createdByUserId, idempotencyKeyHash],
      );
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RelayError("card_activation_idempotency_conflict", "Idempotency-Key was already used with different Card Activation parameters", 409);
        return existing;
      }
      const keyring = loadCardActivationKeyring();
      if (!keyring) throw new RelayError("card_activation_export_key_unavailable", "Card Activation export keyring is not configured", 503);
      if (input.cardType === "plan") {
        const plan = planId ? await transaction.getPlan(planId) : undefined;
        if (!plan || plan.planStatus !== "enabled" || plan.billingMode !== "prepaid" || plan.scopeRef !== "global:") {
          throw new RelayError("card_activation_product_unavailable", "Card Activation Plan is unavailable", 409);
        }
        if (creditProductId !== null || creditAmountUnits !== null) throw new RelayError("card_activation_product_shape_invalid", "Plan Card Activation requires exactly one Plan", 400);
      } else if (input.cardType === "credit") {
        const product = creditProductId ? await transaction.getCreditProduct(creditProductId) : undefined;
        if (planId !== null || !creditProductId || !Number.isSafeInteger(creditAmountUnits) || (creditAmountUnits ?? 0) <= 0) throw new RelayError("card_activation_product_shape_invalid", "Credit Card Activation requires a product and positive amount snapshot", 400);
        if (!product || product.status !== "enabled") throw new RelayError("card_activation_product_unavailable", "Card Activation Credit product is unavailable", 409);
      } else {
        throw new RelayError("card_activation_product_shape_invalid", "Card Activation product type is invalid", 400);
      }
      const now = nowIso();
      const id = createId("card_activation_batch");
      const encrypted = encryptCardActivationSeed(createCardActivationSeed(), id, keyring);
      const batch: CardActivationBatch = {
        id, referenceCode, cardType: input.cardType, planId, creditProductId, creditAmountUnits, quantity, redeemExpiresAt,
        exportSeedCiphertext: encrypted.ciphertext, exportKeyVersion: encrypted.keyVersion, idempotencyKeyHash, requestHash,
        createdByUserId: input.createdByUserId, createdAt: now, revokedAt: null, revokedByUserId: null, revocationReason: null,
      };
      try {
        await transaction.insertRow<CardActivationBatch>("card_activation_batches", batch);
      } catch (error) {
        if (postgresUniqueConstraintError(error)) {
          const concurrent = await transaction.one<CardActivationBatch>(`SELECT * FROM "card_activation_batches" WHERE "created_by_user_id" = $1 AND "idempotency_key_hash" = $2`, [input.createdByUserId, idempotencyKeyHash]);
          if (concurrent) {
            if (concurrent.requestHash !== requestHash) throw new RelayError("card_activation_idempotency_conflict", "Idempotency-Key was already used with different Card Activation parameters", 409);
            return concurrent;
          }
          throw new RelayError("card_activation_reference_conflict", "Card Activation referenceCode is already in use", 409);
        }
        throw error;
      }
      const seed = decryptCardActivationSeed(encrypted.ciphertext, id, keyring);
      for (let ordinal = 1; ordinal <= quantity; ordinal += 1) {
        const code = createCardActivationCode(seed, id, ordinal);
        await transaction.insertRow<CardActivationCode>("card_activation_codes", {
          id: createId("card_activation_code"), batchId: id, ordinal, codeHash: cardActivationCodeHash(code), codeSuffix: code.slice(-8), createdAt: now,
          revokedAt: null, revokedByUserId: null, revocationReason: null, redeemedAt: null, redeemedByUserId: null, redeemedCardId: null,
        });
      }
      await transaction.audit({ actor: { actorType: "user", actorId: input.createdByUserId }, action: "card.activation_batch.create", resource: { resourceType: "card_activation_batch", resourceId: id }, result: "success", source: "owner", requestId: input.requestId, metadata: { batchId: id, referenceCode, cardType: input.cardType, planId, creditProductId, creditAmountUnits, quantity, redeemExpiresAt } });
      return batch;
    });
  }

  async exportCardActivationBatch(batchId: string, actorUserId: string, requestId?: string | null): Promise<{ batch: CardActivationBatch; codes: Array<{ ordinal: number; code: string }> }> {
    return this.withRetriedTransaction(async (transaction) => {
      const batch = await transaction.one<CardActivationBatch>(`SELECT * FROM "card_activation_batches" WHERE "id" = $1`, [batchId]);
      if (!batch) throw new RelayError("card_activation_batch_not_found", "Card Activation batch not found", 404);
      const keyring = loadCardActivationKeyring();
      if (!keyring) throw new RelayError("card_activation_export_key_unavailable", "Card Activation export keyring is not configured", 503);
      let seed: Buffer;
      try {
        seed = decryptCardActivationSeed(batch.exportSeedCiphertext, batch.id, keyring);
      } catch (error) {
        if (error instanceof Error && error.message === "card_activation_export_key_unavailable") throw new RelayError("card_activation_export_key_unavailable", "Card Activation export key version is unavailable", 503);
        throw new RelayError("card_activation_export_unavailable", "Card Activation export is unavailable", 503);
      }
      const rows = await transaction.rows<CardActivationCode>(`SELECT * FROM "card_activation_codes" WHERE "batch_id" = $1 ORDER BY "ordinal" ASC`, [batch.id]);
      if (rows.length !== batch.quantity) throw new RelayError("card_activation_export_unavailable", "Card Activation batch is incomplete", 500);
      const codes = rows.map((row) => {
        const code = createCardActivationCode(seed, batch.id, row.ordinal);
        if (cardActivationCodeHash(code) !== row.codeHash) throw new RelayError("card_activation_export_unavailable", "Card Activation export integrity check failed", 500);
        return { ordinal: row.ordinal, code };
      });
      await transaction.audit({ actor: { actorType: "user", actorId: actorUserId }, action: "card.activation_batch.export", resource: { resourceType: "card_activation_batch", resourceId: batch.id }, result: "success", source: "owner", requestId, metadata: { batchId: batch.id, referenceCode: batch.referenceCode, cardType: batch.cardType, quantity: batch.quantity, redeemExpiresAt: batch.redeemExpiresAt } });
      return { batch, codes };
    });
  }

  async listCardActivationBatches(input: { page?: number; pageSize?: number; cardType?: CardType; status?: CardActivationCodeStatus } = {}): Promise<{ items: Array<CardActivationBatch & { stats: CardActivationStats }>; page: number; pageSize: number; total: number; totalPages: number }> {
    const pageSize = postgresCardActivationPageSize(input.pageSize);
    const requestedPage = Math.max(1, Math.trunc(input.page ?? 1));
    const now = nowIso();
    const statusColumn = input.status === "available" ? '"available_count"'
      : input.status === "redeemed" ? '"redeemed_count"'
        : input.status === "revoked" ? '"revoked_count"'
          : input.status === "expired" ? '"expired_count"' : null;
    const baseValues: unknown[] = [now, now];
    const typeFilter = input.cardType ? `WHERE batch."card_type" = $3` : "";
    if (input.cardType) baseValues.push(input.cardType);
    const statusFilter = statusColumn ? ` AND stats.${statusColumn} > 0` : "";
    const statsCte = `WITH batch_stats AS (
      SELECT batch."id",
        COUNT(code."id")::int AS "total_count",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NOT NULL)::int AS "redeemed_count",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND (code."revoked_at" IS NOT NULL OR batch."revoked_at" IS NOT NULL))::int AS "revoked_count",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND code."revoked_at" IS NULL AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" <= $1)::int AS "expired_count",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND code."revoked_at" IS NULL AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" > $2)::int AS "available_count"
      FROM "card_activation_batches" batch
      LEFT JOIN "card_activation_codes" code ON code."batch_id" = batch."id"
      GROUP BY batch."id"
    )`;
    const total = safePostgresInteger((await this.one<{ count: number }>(`${statsCte}
      SELECT COUNT(*)::int AS "count"
      FROM "card_activation_batches" batch
      INNER JOIN batch_stats stats ON stats."id" = batch."id"
      ${typeFilter}${statusFilter}`, baseValues))?.count ?? 0, "postgres_card_activation_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const limitParam = baseValues.length + 1;
    const offsetParam = baseValues.length + 2;
    const rows = await this.rows<CardActivationBatch & { totalCount: number; redeemedCount: number; revokedCount: number; expiredCount: number; availableCount: number }>(`${statsCte}
      SELECT batch.*,
        stats."total_count",
        stats."redeemed_count",
        stats."revoked_count",
        stats."expired_count",
        stats."available_count"
      FROM "card_activation_batches" batch
      INNER JOIN batch_stats stats ON stats."id" = batch."id"
      ${typeFilter}${statusFilter}
      ORDER BY batch."created_at" ASC, batch."id" ASC
      LIMIT $${limitParam} OFFSET $${offsetParam}`, [...baseValues, pageSize, (page - 1) * pageSize]);
    const items = rows.map(({ totalCount, redeemedCount, revokedCount, expiredCount, availableCount, ...batch }) => ({
      ...batch,
      stats: { total: totalCount, available: availableCount, redeemed: redeemedCount, revoked: revokedCount, expired: expiredCount, redemptionRate: totalCount === 0 ? 0 : redeemedCount / totalCount },
    }));
    return { items, page, pageSize, total, totalPages };
  }

  async getCardActivationBatchDetail(batchId: string, page = 1, pageSize = 20): Promise<CardActivationBatchDetail | undefined> {
    const batch = await this.one<CardActivationBatch>(`SELECT * FROM "card_activation_batches" WHERE "id" = $1`, [batchId]);
    if (!batch) return undefined;
    const normalizedSize = postgresCardActivationPageSize(pageSize);
    const totalCodes = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "card_activation_codes" WHERE "batch_id" = $1`, [batch.id]))?.count ?? 0, "postgres_card_activation_code_count_invalid");
    const totalPages = Math.max(1, Math.ceil(totalCodes / normalizedSize));
    const normalizedPage = Math.min(Math.max(1, Math.trunc(page)), totalPages);
    const at = nowIso();
    const codes = await this.rows<CardActivationCodeView>(`
      SELECT code."id", code."batch_id", code."ordinal", code."code_suffix", code."created_at",
        code."revoked_at", code."revoked_by_user_id", code."revocation_reason",
        code."redeemed_at", code."redeemed_by_user_id", code."redeemed_card_id",
        CASE
          WHEN code."redeemed_at" IS NOT NULL THEN 'redeemed'
          WHEN code."revoked_at" IS NOT NULL OR batch."revoked_at" IS NOT NULL THEN 'revoked'
          WHEN batch."redeem_expires_at" <= $1 THEN 'expired'
          ELSE 'available'
        END AS "status"
      FROM "card_activation_codes" code
      INNER JOIN "card_activation_batches" batch ON batch."id" = code."batch_id"
      WHERE code."batch_id" = $2
      ORDER BY code."ordinal" ASC
      LIMIT $3 OFFSET $4`, [at, batch.id, normalizedSize, (normalizedPage - 1) * normalizedSize]);
    return { batch, codes, totalCodes, page: normalizedPage, pageSize: normalizedSize, totalPages, stats: await this.postgresCardActivationStatsForBatch(batch, at) };
  }

  async getCardActivationStats(input: { batchId?: string; cardType?: CardType } = {}): Promise<CardActivationStats> {
    const at = nowIso();
    const conditions: string[] = [];
    const values: unknown[] = [at, at];
    if (input.batchId) { conditions.push(`batch."id" = $${values.length + 1}`); values.push(input.batchId); }
    if (input.cardType) { conditions.push(`batch."card_type" = $${values.length + 1}`); values.push(input.cardType); }
    const rows = await this.rows<{ total: number; redeemed: number; revoked: number; expired: number; available: number }>(`
      SELECT COUNT(code."id")::int AS "total",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NOT NULL)::int AS "redeemed",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND (code."revoked_at" IS NOT NULL OR batch."revoked_at" IS NOT NULL))::int AS "revoked",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND code."revoked_at" IS NULL AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" <= $1)::int AS "expired",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND code."revoked_at" IS NULL AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" > $2)::int AS "available"
      FROM "card_activation_batches" batch
      LEFT JOIN "card_activation_codes" code ON code."batch_id" = batch."id"
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      GROUP BY batch."id"`, values);
    const stats = postgresEmptyCardActivationStats();
    for (const row of rows) postgresAddCardActivationStats(stats, {
      total: Number(row.total ?? 0), available: Number(row.available ?? 0), redeemed: Number(row.redeemed ?? 0), revoked: Number(row.revoked ?? 0), expired: Number(row.expired ?? 0), redemptionRate: 0,
    });
    stats.redemptionRate = stats.total === 0 ? 0 : stats.redeemed / stats.total;
    return stats;
  }

  async revokeCardActivationBatch(batchId: string, actorUserId: string, reason: string, requestId?: string | null): Promise<CardActivationBatch> {
    return this.withRetriedTransaction(async (transaction) => {
      const batch = await transaction.one<CardActivationBatch>(`SELECT * FROM "card_activation_batches" WHERE "id" = $1 FOR UPDATE`, [batchId]);
      if (!batch) throw new RelayError("card_activation_batch_not_found", "Card Activation batch not found", 404);
      if (batch.revokedAt) return batch;
      const normalizedReason = postgresNormalizeCardActivationReason(reason);
      const now = nowIso();
      const result = await transaction.one<CardActivationBatch>(`UPDATE "card_activation_batches" SET "revoked_at" = $2, "revoked_by_user_id" = $3, "revocation_reason" = $4 WHERE "id" = $1 AND "revoked_at" IS NULL RETURNING *`, [batch.id, now, actorUserId, normalizedReason]);
      if (!result) return (await transaction.one<CardActivationBatch>(`SELECT * FROM "card_activation_batches" WHERE "id" = $1`, [batch.id]))!;
      await transaction.audit({ actor: { actorType: "user", actorId: actorUserId }, action: "card.activation_batch.revoke", resource: { resourceType: "card_activation_batch", resourceId: batch.id }, result: "success", source: "owner", requestId, metadata: { batchId: batch.id, referenceCode: batch.referenceCode, reasonCode: normalizedReason } });
      return result;
    });
  }

  async revokeCardActivationCode(codeId: string, actorUserId: string, reason: string, requestId?: string | null): Promise<CardActivationCode> {
    return this.withRetriedTransaction(async (transaction) => {
      const code = await transaction.one<CardActivationCode>(`SELECT * FROM "card_activation_codes" WHERE "id" = $1 FOR UPDATE`, [codeId]);
      if (!code) throw new RelayError("card_activation_code_not_found", "Card Activation code not found", 404);
      if (code.revokedAt || code.redeemedAt) return code;
      const normalizedReason = postgresNormalizeCardActivationReason(reason);
      const result = await transaction.one<CardActivationCode>(`UPDATE "card_activation_codes" SET "revoked_at" = $2, "revoked_by_user_id" = $3, "revocation_reason" = $4 WHERE "id" = $1 AND "revoked_at" IS NULL AND "redeemed_at" IS NULL RETURNING *`, [code.id, nowIso(), actorUserId, normalizedReason]);
      if (!result) return (await transaction.one<CardActivationCode>(`SELECT * FROM "card_activation_codes" WHERE "id" = $1`, [code.id]))!;
      await transaction.audit({ actor: { actorType: "user", actorId: actorUserId }, action: "card.activation_code.revoke", resource: { resourceType: "card_activation_code", resourceId: code.id }, result: "success", source: "owner", requestId, metadata: { codeId: code.id, batchId: code.batchId, reasonCode: normalizedReason } });
      return result;
    });
  }

  async previewCardActivationCode(codeHash: string, at = nowIso()): Promise<CardActivationPreview | undefined> {
    const row = await this.one<{ batchId: string; referenceCode: string; cardType: CardType; planId: string | null; creditProductId: string | null; creditAmountUnits: number | null; redeemExpiresAt: string; codeRevokedAt: string | null; codeRedeemedAt: string | null; batchRevokedAt: string | null; planName: string | null; planVersion: number | null; productName: string | null }>(
      `SELECT code."revoked_at" AS "codeRevokedAt", code."redeemed_at" AS "codeRedeemedAt", batch."id" AS "batchId", batch."reference_code" AS "referenceCode", batch."card_type" AS "cardType", batch."plan_id" AS "planId", batch."credit_product_id" AS "creditProductId", batch."credit_amount_units" AS "creditAmountUnits", batch."redeem_expires_at" AS "redeemExpiresAt", batch."revoked_at" AS "batchRevokedAt", plan."name" AS "planName", plan."version" AS "planVersion", product."display_name" AS "productName" FROM "card_activation_codes" code INNER JOIN "card_activation_batches" batch ON batch."id" = code."batch_id" LEFT JOIN "plans" plan ON plan."id" = batch."plan_id" LEFT JOIN "credit_products" product ON product."id" = batch."credit_product_id" WHERE code."code_hash" = $1`,
      [codeHash],
    );
    if (!row || row.codeRedeemedAt || row.codeRevokedAt || row.batchRevokedAt || row.redeemExpiresAt <= at) return undefined;
    if (row.cardType === "plan" && (!row.planId || !row.planName || row.planVersion === null)) return undefined;
    if (row.cardType === "credit" && (!row.creditProductId || !row.productName || !Number.isSafeInteger(row.creditAmountUnits) || (row.creditAmountUnits ?? 0) <= 0)) return undefined;
    return {
      batchId: row.batchId, referenceCode: row.referenceCode, cardType: row.cardType, redeemExpiresAt: row.redeemExpiresAt,
      plan: row.cardType === "plan" ? { id: row.planId!, name: row.planName!, version: row.planVersion!, expiresInDays: 730 } : null,
      credit: row.cardType === "credit" ? { productId: row.creditProductId!, name: row.productName!, amountUnits: row.creditAmountUnits!, expiresInDays: 730 } : null,
    };
  }

  async redeemCardActivationCode(codeHash: string, userId: string, context: { requestId?: string | null } = {}): Promise<CardActivationRedeemResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const row = await transaction.one<{ codeId: string; batchId: string; referenceCode: string; cardType: CardType; planId: string | null; creditProductId: string | null; creditAmountUnits: number | null; redeemExpiresAt: string; codeRevokedAt: string | null; codeRedeemedAt: string | null; redeemedByUserId: string | null; redeemedCardId: string | null; batchRevokedAt: string | null }>(
        `SELECT code."id" AS "codeId", code."batch_id" AS "batchId", code."revoked_at" AS "codeRevokedAt", code."redeemed_at" AS "codeRedeemedAt", code."redeemed_by_user_id" AS "redeemedByUserId", code."redeemed_card_id" AS "redeemedCardId", batch."reference_code" AS "referenceCode", batch."card_type" AS "cardType", batch."plan_id" AS "planId", batch."credit_product_id" AS "creditProductId", batch."credit_amount_units" AS "creditAmountUnits", batch."redeem_expires_at" AS "redeemExpiresAt", batch."revoked_at" AS "batchRevokedAt" FROM "card_activation_codes" code INNER JOIN "card_activation_batches" batch ON batch."id" = code."batch_id" WHERE code."code_hash" = $1 FOR UPDATE`,
        [codeHash],
      );
      if (!row) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
      if (row.codeRedeemedAt) {
        if (row.redeemedByUserId !== userId || !row.redeemedCardId) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
        const card = await transaction.getCard(row.redeemedCardId);
        if (!card) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
        return { outcome: "already_redeemed" as const, card };
      }
      const user = await transaction.getUser(userId);
      if (!user || user.status !== "enabled" || row.codeRevokedAt || row.batchRevokedAt || row.redeemExpiresAt <= nowIso()) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
      let planId: string | null = null;
      let creditProductId: string | null = null;
      let creditAmountUnits: number | null = null;
      if (row.cardType === "plan") {
        const plan = row.planId ? await transaction.getPlan(row.planId) : undefined;
        if (!plan || !isPlanRuntimeEnabled(plan.planStatus) || plan.billingMode !== "prepaid" || plan.scopeRef !== "global:") throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
        planId = plan.id;
      } else {
        const product = row.creditProductId ? await transaction.getCreditProduct(row.creditProductId) : undefined;
        if (!product || !Number.isSafeInteger(row.creditAmountUnits) || (row.creditAmountUnits ?? 0) <= 0) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
        creditProductId = product.id;
        creditAmountUnits = row.creditAmountUnits;
      }
      const now = nowIso();
      const card = await transaction.createCard({ cardType: row.cardType, issuanceType: "external_activation", ownerUserId: userId, planId, creditProductId, creditAmountUnits, createdAt: now, expiresAt: new Date(Date.parse(now) + 63_072_000_000).toISOString() });
      const updated = await transaction.one<CardActivationCode>(`UPDATE "card_activation_codes" SET "redeemed_at" = $2, "redeemed_by_user_id" = $3, "redeemed_card_id" = $4 WHERE "id" = $1 AND "redeemed_at" IS NULL AND "revoked_at" IS NULL RETURNING *`, [row.codeId, now, userId, card.id]);
      if (!updated) throw new RelayError("card_activation_unavailable", "Card Activation code is unavailable", 409);
      await transaction.audit({ actor: { actorType: "user", actorId: userId }, action: "card.activation_code.redeem", resource: { resourceType: "card", resourceId: card.id }, result: "success", source: "web", requestId: context.requestId, metadata: { batchId: row.batchId, referenceCode: row.referenceCode, cardId: card.id, userId, cardType: row.cardType, planId, creditProductId, creditAmountUnits, expiresAt: card.expiresAt } });
      return { outcome: "created" as const, card: (await transaction.getCard(card.id))! };
    });
  }

  private async postgresCardActivationStatsForBatch(batch: CardActivationBatch, at: string): Promise<CardActivationStats> {
    const row = await this.one<{ total: number; redeemed: number; revoked: number; expired: number; available: number }>(`
      SELECT COUNT(code."id")::int AS "total",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NOT NULL)::int AS "redeemed",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND (code."revoked_at" IS NOT NULL OR batch."revoked_at" IS NOT NULL))::int AS "revoked",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND code."revoked_at" IS NULL AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" <= $1)::int AS "expired",
        COUNT(*) FILTER (WHERE code."redeemed_at" IS NULL AND code."revoked_at" IS NULL AND batch."revoked_at" IS NULL AND batch."redeem_expires_at" > $1)::int AS "available"
      FROM "card_activation_codes" code
      INNER JOIN "card_activation_batches" batch ON batch."id" = code."batch_id"
      WHERE code."batch_id" = $2`, [at, batch.id]);
    const stats = postgresEmptyCardActivationStats();
    stats.total = Number(row?.total ?? 0);
    stats.redeemed = Number(row?.redeemed ?? 0);
    stats.revoked = Number(row?.revoked ?? 0);
    stats.expired = Number(row?.expired ?? 0);
    stats.available = Number(row?.available ?? 0);
    stats.redemptionRate = stats.total === 0 ? 0 : stats.redeemed / stats.total;
    return stats;
  }

  async getFirstEnabledApiKeyForUser(userId: string): Promise<ApiKey | undefined> {
    return this.one<ApiKey>(
      `SELECT * FROM "api_keys"
       WHERE "user_id" = $1 AND "status" = 'enabled' AND "revoked_at" IS NULL
       ORDER BY "created_at" ASC, "id" ASC LIMIT 1`,
      [userId],
    );
  }

  async listCreditTopupAttachments(topupId: string): Promise<CreditTopupAttachment[]> {
    return this.rows<CreditTopupAttachment>(
      `SELECT * FROM "credit_topup_attachments"
       WHERE "topup_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
      [topupId],
    );
  }

  async createCreditTopupAttachment(input: Omit<CreditTopupAttachment, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<CreditTopupAttachment> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.getCreditTopup(input.topupId);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      postgresValidateImageAttachment(input.contentType, input.byteSize);
      const existing = await transaction.one<CreditTopupAttachment>(
        `SELECT * FROM "credit_topup_attachments"
         WHERE "topup_id" = $1 AND "sha256" = $2 AND "attachment_purpose" = $3
         LIMIT 1`,
        [input.topupId, input.sha256, input.attachmentPurpose],
      );
      if (existing) return existing;
      const now = input.createdAt ?? nowIso();
      if (input.attachmentPurpose === "payment_evidence") {
        if (topup.settlementMode !== "manual_review") throw new RelayError("credit_topup_payment_reference_unavailable", "Stripe Checkout topups do not accept manual payment evidence", 409);
        if (topup.status !== "pending_payment") throw new RelayError("credit_topup_attachment_closed", "Payment evidence can only be uploaded while awaiting payment", 409);
        if (Date.parse(now) >= Date.parse(topup.expiresAt)) {
          await transaction.query(`UPDATE "credit_topups" SET "status" = 'expired', "expired_at" = $2, "updated_at" = $2 WHERE "id" = $1 AND "status" = 'pending_payment'`, [topup.id, now]);
          throw new RelayError("credit_topup_expired", "Credit topup has expired", 409);
        }
      }
      const row = await transaction.insertRow<CreditTopupAttachment>("credit_topup_attachments", {
        ...input,
        id: input.id ?? createId("credit_topup_attachment"),
        createdAt: now,
      });
      if (input.attachmentPurpose === "payment_evidence") {
        await transaction.query(
          `UPDATE "credit_topups"
           SET "status" = 'pending_review', "payment_submitted_at" = $2, "updated_at" = $2
           WHERE "id" = $1 AND "status" = 'pending_payment'`,
          [topup.id, now],
        );
      }
      return row;
    });
  }

  async createUserCreditTopup(input: { userId: string; productListingId: string; idempotencyKey: string; useImmediately: boolean }): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      if (typeof input.useImmediately !== "boolean") throw new RelayError("credit_topup_use_immediately_required", "useImmediately must be a boolean", 400);
      const now = nowIso();
      await transaction.query(
        `UPDATE "credit_topups" SET "status" = 'expired', "expired_at" = $2, "updated_at" = $2
         WHERE "user_id" = $1 AND "status" = 'pending_payment' AND "settlement_mode" = 'manual_review' AND "expires_at" <= $2`,
        [input.userId, now],
      );
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ productListingId: input.productListingId, useImmediately: input.useImmediately }));
      const existing = await transaction.one<CreditTopup>(
        `SELECT * FROM "credit_topups" WHERE "user_id" = $1 AND "create_idempotency_key_hash" = $2`,
        [input.userId, idempotencyKeyHash],
      );
      if (existing) {
        if (existing.createRequestHash !== requestHash) throw new RelayError("idempotency_conflict", "Idempotency key was already used with a different request", 409);
        return existing;
      }
      const open = await transaction.one<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "credit_topups" WHERE "user_id" = $1 AND "status" IN ('pending_payment', 'pending_review')`,
        [input.userId],
      );
      if (Number(open?.count ?? 0) >= 2) throw new RelayError("credit_topup_open_limit", "At most two topups may be pending", 409);
      const listing = await transaction.getCreditProductListing(input.productListingId);
      if (!listing || listing.status !== "enabled") throw new RelayError("credit_product_listing_not_enabled", "Credit product listing is not enabled", 409);
      const product = await transaction.getCreditProduct(listing.productId);
      const channel = await transaction.getPaymentChannel(listing.paymentChannelId);
      if (!product || product.status !== "enabled" || !channel || channel.status !== "enabled" || !["manual_review", "stripe_checkout"].includes(channel.settlementMode)) {
        throw new RelayError("credit_topup_configuration_unavailable", "Credit product configuration is unavailable", 409);
      }
      const row: CreditTopup = {
        id: createId("credit_topup"), userId: input.userId, creditAccountId: null, scopeRef: null,
        productId: product.id, productListingId: listing.id, creditedAmountUnits: product.creditedAmountUnits,
        expectedPaymentAmountUnits: listing.priceAmountUnits, confirmedReceivedAmountUnits: null,
        paymentAsset: channel.paymentAsset, paymentChannelId: channel.id, paymentNetwork: channel.paymentNetwork,
        settlementMode: channel.settlementMode, recipientIdentifierType: channel.recipientIdentifierType,
        normalizedRecipientIdentifierHash: channel.normalizedRecipientIdentifierHash,
        transactionReferenceType: channel.transactionReferenceType, transactionReference: null,
        normalizedTransactionReferenceHash: null, transactionReferenceTail: null, claimedPaidAt: null,
        paymentSubmittedAt: null, expiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
        expiredAt: null, paymentFailedAt: null, creditedAt: null, useImmediately: input.useImmediately, cardId: null,
        status: "pending_payment", ledgerEventId: null, reviewedByUserId: null, reviewedAt: null,
        reviewNote: null, adminNote: null, refundNote: null, refundRecordedByUserId: null,
        refundRecordedAt: null, createIdempotencyKeyHash: idempotencyKeyHash, createRequestHash: requestHash,
        createdAt: now, updatedAt: now, cancelledByUserId: null, cancelledAt: null,
        reversedByUserId: null, reversedAt: null, reversalLedgerEventId: null, reversalReason: null,
      };
      return transaction.insertRow<CreditTopup>("credit_topups", row);
    });
  }

  async submitCreditTopupPaymentReference(input: { topupId: string; userId: string; transactionReference: string; claimedPaidAt?: string | null }): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.getCreditTopup(input.topupId);
      if (!topup || topup.userId !== input.userId) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      if (topup.settlementMode !== "manual_review") throw new RelayError("credit_topup_payment_reference_unavailable", "Stripe Checkout topups do not accept manual payment references", 409);
      const now = nowIso();
      if (topup.status !== "pending_payment") throw new RelayError("credit_topup_not_pending_payment", "Only pending payment topups accept payment references", 409);
      if (Date.parse(now) >= Date.parse(topup.expiresAt)) {
        await transaction.query(`UPDATE "credit_topups" SET "status" = 'expired', "expired_at" = $2, "updated_at" = $2 WHERE "id" = $1`, [topup.id, now]);
        throw new RelayError("credit_topup_expired", "Credit topup has expired", 409);
      }
      const transactionReference = postgresRequiredTrimmed(input.transactionReference, "transactionReference");
      postgresRejectSensitivePaymentIdentifier(transactionReference);
      const referenceHash = postgresSha256Text(postgresNormalizePaymentIdentifier(transactionReference));
      const duplicate = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "credit_topups"
         WHERE "payment_network" = $1 AND "normalized_recipient_identifier_hash" = $2
           AND "normalized_transaction_reference_hash" = $3 AND "id" <> $4 LIMIT 1`,
        [topup.paymentNetwork, topup.normalizedRecipientIdentifierHash, referenceHash, topup.id],
      );
      if (duplicate) throw new RelayError("duplicate_transaction_reference", "This payment transaction reference has already been used", 409);
      const claimedPaidAt = input.claimedPaidAt?.trim() || null;
      if (claimedPaidAt && Number.isNaN(Date.parse(claimedPaidAt))) throw new RelayError("invalid_claimed_paid_at", "claimedPaidAt must be an ISO timestamp", 400);
      const result = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups"
         SET "transaction_reference" = $2, "normalized_transaction_reference_hash" = $3,
             "transaction_reference_tail" = $4, "claimed_paid_at" = $5,
             "payment_submitted_at" = $6, "status" = 'pending_review', "updated_at" = $6
         WHERE "id" = $1 AND "status" = 'pending_payment' RETURNING *`,
        [topup.id, transactionReference, referenceHash, transactionReference.slice(-8), claimedPaidAt, now],
      );
      if (!result.rows[0]) throw new RelayError("credit_topup_not_pending_payment", "Only pending payment topups accept payment references", 409);
      return mapPostgresRow<CreditTopup>(result.rows[0]);
    });
  }

  async cancelUserCreditTopup(input: { topupId: string; userId: string }): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.getCreditTopup(input.topupId);
      if (!topup || topup.userId !== input.userId) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      if (topup.status !== "pending_payment") throw new RelayError("credit_topup_not_pending_payment", "Only pending payment topups can be cancelled", 409);
      const now = nowIso();
      const result = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups"
         SET "status" = 'cancelled', "cancelled_by_user_id" = $2, "cancelled_at" = $3, "updated_at" = $3
         WHERE "id" = $1 AND "user_id" = $2 AND "status" = 'pending_payment' RETURNING *`,
        [topup.id, input.userId, now],
      );
      if (!result.rows[0]) throw new RelayError("credit_topup_not_pending_payment", "Only pending payment topups can be cancelled", 409);
      return mapPostgresRow<CreditTopup>(result.rows[0]);
    });
  }

  async approveCreditTopup(input: Parameters<ApplicationOperationPort["approveCreditTopup"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["approveCreditTopup"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.one<CreditTopup>(`SELECT * FROM "credit_topups" WHERE "id" = $1 FOR UPDATE`, [input.topupId]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      if (topup.settlementMode !== "manual_review") throw new RelayError("credit_topup_manual_review_unavailable", "Stripe Checkout topups cannot be manually approved", 409);
      if (topup.status === "credited" && topup.ledgerEventId) {
        const ledgerEvent = await transaction.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "id" = $1`, [topup.ledgerEventId]);
        return { topup, card: null, ledgerEvent: ledgerEvent ?? null, account: topup.creditAccountId ? await transaction.getCreditAccount(topup.creditAccountId) ?? null : null };
      }
      if (topup.status === "fulfilled" && topup.cardId) {
        const card = await transaction.getCard(topup.cardId);
        if (!card) throw new RelayError("credit_topup_card_missing", "Fulfilled topup Card is missing", 500);
        const ledgerEvent = await transaction.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "card_id" = $1 LIMIT 1`, [card.id]);
        return { topup, card, ledgerEvent: ledgerEvent ?? null, account: ledgerEvent ? await transaction.getCreditAccount(ledgerEvent.accountId) ?? null : null };
      }
      if (topup.status !== "pending_review" || !topup.paymentSubmittedAt) throw new RelayError("credit_topup_not_pending_review", "Only submitted topups can be approved", 409);
      const reviewNote = postgresRequiredTrimmed(input.reviewNote, "reviewNote");
      const confirmedReceivedAmountUnits = postgresRequiredPaymentUnits(input.confirmedReceivedAmountUnits, topup.paymentAsset, "confirmedReceivedAmountUnits");
      const evidence = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "credit_topup_attachments" WHERE "topup_id" = $1 AND "attachment_purpose" = 'payment_evidence' LIMIT 1`,
        [topup.id],
      );
      if (!topup.transactionReference && !evidence) throw new RelayError("credit_topup_payment_evidence_required", "User payment evidence is required before approval", 409);
      const now = nowIso();
      if (topup.useImmediately !== null) {
        const card = await transaction.createCard({ cardType: "credit", ownerUserId: topup.userId, creditProductId: topup.productId, creditAmountUnits: topup.creditedAmountUnits, createdAt: now });
        const used = topup.useImmediately ? await transaction.useCard({ cardId: card.id, ownerUserId: topup.userId }) : null;
        const updated = await transaction.query<CreditTopup>(
          `UPDATE "credit_topups"
           SET "status" = 'fulfilled', "confirmed_received_amount_units" = $2, "card_id" = $3,
               "credited_at" = $4, "reviewed_by_user_id" = $5, "reviewed_at" = $4,
               "review_note" = $6, "updated_at" = $4 WHERE "id" = $1 RETURNING *`,
          [topup.id, confirmedReceivedAmountUnits, card.id, now, input.ownerUserId, reviewNote],
        );
        if (!updated.rows[0]) throw new RelayError("credit_topup_not_found", "Credit topup could not be updated", 404);
        return { topup: mapPostgresRow<CreditTopup>(updated.rows[0]), card: used?.card ?? (await transaction.getCard(card.id))!, ledgerEvent: used?.cardType === "credit" ? used.ledgerEvent : null, account: used?.cardType === "credit" ? used.account : null };
      }
      if (!topup.creditAccountId || !topup.scopeRef) throw new RelayError("credit_account_not_found", "Historical topup credit account is missing", 404);
      const account = await transaction.getCreditAccount(topup.creditAccountId);
      if (!account || account.status !== "active" || account.scopeRef !== topup.scopeRef || topup.scopeRef !== userScopeRef(topup.userId)) throw new RelayError("credit_account_not_found", "Active topup credit account not found", 404);
      const ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "top_up", amountUnits: topup.creditedAmountUnits, transferId: null, relatedEventId: null, planSubscriptionId: null, billingEventId: null, relatedTopupId: topup.id, fromAccountId: null, toAccountId: account.id, reason: `credit_topup:${topup.id}`, actorUserId: input.ownerUserId });
      const updated = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups"
         SET "status" = 'credited', "confirmed_received_amount_units" = $2, "ledger_event_id" = $3,
             "credited_at" = $4, "reviewed_by_user_id" = $5, "reviewed_at" = $4,
             "review_note" = $6, "updated_at" = $4 WHERE "id" = $1 RETURNING *`,
        [topup.id, confirmedReceivedAmountUnits, ledgerEvent.id, now, input.ownerUserId, reviewNote],
      );
      if (!updated.rows[0]) throw new RelayError("credit_topup_not_found", "Credit topup could not be updated", 404);
      return { topup: mapPostgresRow<CreditTopup>(updated.rows[0]), card: null, ledgerEvent, account: await transaction.getCreditAccount(account.id) ?? account };
    });
  }

  async rejectCreditTopup(input: Parameters<ApplicationOperationPort["rejectCreditTopup"]>[0]): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.one<CreditTopup>(`SELECT * FROM "credit_topups" WHERE "id" = $1 FOR UPDATE`, [input.topupId]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      if (topup.status !== "pending_review") throw new RelayError("credit_topup_not_pending_review", "Only pending review topups can be rejected", 409);
      const confirmed = input.confirmedReceivedAmountUnits == null ? null : postgresRequiredPaymentUnits(input.confirmedReceivedAmountUnits, topup.paymentAsset, "confirmedReceivedAmountUnits");
      const now = nowIso();
      const updated = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups" SET "status" = 'rejected', "confirmed_received_amount_units" = $2,
         "reviewed_by_user_id" = $3, "reviewed_at" = $4, "review_note" = $5, "updated_at" = $4
         WHERE "id" = $1 AND "status" = 'pending_review' RETURNING *`,
        [topup.id, confirmed, input.ownerUserId, now, postgresRequiredTrimmed(input.reviewNote, "reviewNote")],
      );
      if (!updated.rows[0]) throw new RelayError("credit_topup_not_pending_review", "Only pending review topups can be rejected", 409);
      return mapPostgresRow<CreditTopup>(updated.rows[0]);
    });
  }

  async reverseCreditTopup(input: Parameters<ApplicationOperationPort["reverseCreditTopup"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["reverseCreditTopup"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.one<CreditTopup>(`SELECT * FROM "credit_topups" WHERE "id" = $1 FOR UPDATE`, [input.topupId]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      const now = nowIso();
      const reversalReason = postgresRequiredTrimmed(input.reversalReason, "reversalReason");
      let account: CreditAccount | null = null;
      let ledgerEvent: CreditLedgerEvent | null = null;
      let card: Card | null = null;
      if (topup.status === "credited" && topup.ledgerEventId && topup.creditAccountId) {
        account = await transaction.getCreditAccount(topup.creditAccountId) ?? null;
        if (!account || account.status !== "active") throw new RelayError("credit_account_not_found", "Active topup credit account not found", 404);
        if (account.balanceSnapUnits < topup.creditedAmountUnits) throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient for reversal", 402);
        ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "reversal", amountUnits: -topup.creditedAmountUnits, transferId: null, relatedEventId: topup.ledgerEventId, planSubscriptionId: null, billingEventId: null, relatedTopupId: null, fromAccountId: account.id, toAccountId: null, reason: `credit_topup_reversal:${topup.id}`, actorUserId: input.ownerUserId });
      } else if (topup.status === "fulfilled" && topup.cardId && topup.settlementMode === "stripe_checkout") {
        card = (await transaction.one<Card>(`SELECT * FROM "cards" WHERE "id" = $1 FOR UPDATE`, [topup.cardId])) ?? null;
        if (!card) throw new RelayError("credit_topup_card_missing", "Fulfilled topup Card is missing", 500);
        if (card.usedAt === null) {
          const invalidated = await transaction.query(`UPDATE "cards" SET "invalidated_at" = $2, "invalidation_reason" = $3 WHERE "id" = $1 AND "invalidated_at" IS NULL AND "used_at" IS NULL`, [card.id, now, reversalReason]);
          if ((invalidated.rowCount ?? 0) !== 1) throw new RelayError("card_not_available", "Stripe Credit Card can no longer be invalidated", 409);
          card = (await transaction.getCard(card.id)) ?? card;
        } else {
          const redeemed = await transaction.one<{ id: string; accountId: string }>(`SELECT "id", "account_id" AS "accountId" FROM "credit_ledger_events" WHERE "card_id" = $1 AND "event_type" = 'card_redeem'`, [card.id]);
          if (!redeemed) throw new RelayError("credit_topup_card_redeem_missing", "Redeemed Stripe Credit Card ledger event is missing", 500);
          account = await transaction.getCreditAccount(redeemed.accountId) ?? null;
          if (!account || account.status !== "active") throw new RelayError("credit_account_not_found", "Active redeemed Credit account not found", 404);
          ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "reversal", amountUnits: -topup.creditedAmountUnits, transferId: null, relatedEventId: redeemed.id, planSubscriptionId: null, billingEventId: null, relatedTopupId: null, fromAccountId: account.id, toAccountId: null, reason: `stripe_credit_topup_reversal:${topup.id}`, actorUserId: input.ownerUserId, allowNegativeBalance: true });
        }
      } else {
        throw new RelayError("credit_topup_not_reversible", "Only credited topups or fulfilled Stripe Credit Cards can be reversed", 409);
      }
      const updated = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups" SET "status" = 'reversed', "reversed_by_user_id" = $2, "reversed_at" = $3,
         "reversal_ledger_event_id" = $4, "reversal_reason" = $5, "updated_at" = $3 WHERE "id" = $1 RETURNING *`,
        [topup.id, input.ownerUserId, now, ledgerEvent?.id ?? null, reversalReason],
      );
      if (!updated.rows[0]) throw new RelayError("credit_topup_not_found", "Credit topup could not be updated", 404);
      const reversedTopup = mapPostgresRow<CreditTopup>(updated.rows[0]);
      await transaction.audit({ actor: { actorType: "user", actorId: input.ownerUserId }, source: "owner", requestId: input.requestId, action: "credit_topup.reverse", resource: { resourceType: "credit_topup", resourceId: reversedTopup.id }, result: "success", metadata: { topupId: reversedTopup.id, userId: reversedTopup.userId, settlementMode: reversedTopup.settlementMode, cardId: reversedTopup.cardId, accountId: account?.id ?? null, reversalLedgerEventId: ledgerEvent?.id ?? null } });
      return { topup: reversedTopup, ledgerEvent, account: account ? await transaction.getCreditAccount(account.id) ?? account : null, card };
    });
  }

  async recordCreditTopupRefundNote(input: Parameters<ApplicationOperationPort["recordCreditTopupRefundNote"]>[0]): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.one<CreditTopup>(`SELECT * FROM "credit_topups" WHERE "id" = $1 FOR UPDATE`, [input.topupId]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      if (topup.refundRecordedAt) throw new RelayError("credit_topup_refund_note_exists", "Refund note has already been recorded", 409);
      const now = nowIso();
      const updated = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups" SET "refund_note" = $2, "refund_recorded_by_user_id" = $3, "refund_recorded_at" = $4, "updated_at" = $4 WHERE "id" = $1 RETURNING *`,
        [topup.id, postgresRequiredTrimmed(input.refundNote, "refundNote"), input.ownerUserId, now],
      );
      if (!updated.rows[0]) throw new RelayError("credit_topup_not_found", "Credit topup could not be updated", 404);
      return mapPostgresRow<CreditTopup>(updated.rows[0]);
    });
  }

  async listCreditLedgerEventsForAccount(accountId: string, limit = 20): Promise<Awaited<ReturnType<ApplicationOperationPort["listCreditLedgerEventsForAccount"]>>> {
    const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.rows<CreditLedgerEvent>(
      `SELECT * FROM "credit_ledger_events"
       WHERE "account_id" = $1
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $2`,
      [accountId, normalizedLimit],
    );
  }

  async createAdminCreditLedgerEvent(input: Parameters<ApplicationOperationPort["createAdminCreditLedgerEvent"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createAdminCreditLedgerEvent"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      if (!isRuntimeScopeRef(input.scopeRef)) throw new RelayError("invalid_credit_scope", "Credit ledger events require a runtime scope_ref", 400);
      const reason = postgresRequiredTrimmed(input.reason, "reason");
      const amountUnits = Number(input.amountUnits);
      if (!Number.isSafeInteger(amountUnits) || amountUnits === 0) throw new RelayError("invalid_credit_amount", "Credit adjustment amount units must be a non-zero integer", 400);
      if (input.eventType === "grant" && amountUnits <= 0) throw new RelayError("invalid_credit_grant_amount", "Credit grants must be positive", 400);
      if (!["grant", "adjustment", "reversal"].includes(input.eventType)) throw new RelayError("invalid_credit_event_type", "Unsupported credit ledger event type", 400);
      const account = await transaction.findCreditAccountForScope(input.scopeRef) ?? await transaction.createCreditAccount({ scopeRef: input.scopeRef });
      const ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: input.eventType, amountUnits, transferId: null, relatedEventId: input.relatedEventId ?? null, planSubscriptionId: null, billingEventId: null, fromAccountId: amountUnits < 0 ? account.id : null, toAccountId: amountUnits > 0 ? account.id : null, reason, actorUserId: input.actorUserId });
      return { account: await transaction.getCreditAccount(account.id) ?? account, ledgerEvent };
    });
  }

  async getCreditTransferPolicy(scopeRef: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["getCreditTransferPolicy"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getCreditTransferPolicy"]>>>(
      `SELECT * FROM "credit_transfer_policies" WHERE "scope_ref" = $1`,
      [scopeRef],
    );
  }

  async setCreditTransferPolicy(input: { scopeRef: ScopeRef; transferOutEnabled: boolean; updatedBy?: string | null }): Promise<CreditTransferPolicy> {
    const now = nowIso();
    const existing = await this.getCreditTransferPolicy(input.scopeRef);
    return this.upsertRow<CreditTransferPolicy>("credit_transfer_policies", {
      id: existing?.id ?? createId("credit_transfer_policy"), scopeRef: input.scopeRef,
      transferOutEnabled: input.transferOutEnabled, updatedBy: input.updatedBy ?? null,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    }, ["scopeRef"], ["transferOutEnabled", "updatedBy", "updatedAt"]);
  }

  async createCreditProduct(input: { code: string; displayName: string; description?: string | null; adminNote?: string | null; creditedAmountUnits: number; displayOrder?: number }): Promise<CreditProduct> {
    const code = postgresRequiredCode(input.code, "code");
    const displayName = postgresRequiredTrimmed(input.displayName, "displayName");
    const creditedAmountUnits = postgresRequiredUsdSettlementUnits(input.creditedAmountUnits, "creditedAmountUnits");
    return this.insertRow<CreditProduct>("credit_products", {
      id: createId("credit_product"), code, displayName, description: postgresTrimNullable(input.description),
      adminNote: postgresTrimNullable(input.adminNote), creditedAmountUnits,
      status: "enabled", displayOrder: Number.isSafeInteger(input.displayOrder ?? 0) ? input.displayOrder ?? 0 : 0, createdAt: nowIso(),
    });
  }

  async disableCreditProduct(id: string): Promise<CreditProduct> {
    const product = await this.one<CreditProduct>(`SELECT * FROM "credit_products" WHERE "id" = $1`, [id]);
    if (!product) throw new RelayError("credit_product_not_found", "Credit product not found", 404);
    const updated = await this.updateRow<CreditProduct>("credit_products", id, { status: "disabled" });
    return updated ?? { ...product, status: "disabled" };
  }

  async createPaymentChannel(input: { code: string; displayName: string; paymentNetwork: string; paymentAsset: string; settlementMode: string; recipientIdentifierType: string; transactionReferenceType: string; recipientIdentifier: string; recipientIdentifierDisplay: string; paymentInstruction?: string | null; createdByUserId: string }): Promise<PaymentChannel> {
    const settlementMode = postgresRequiredTrimmed(input.settlementMode, "settlementMode");
    if (settlementMode !== "manual_review" && settlementMode !== "stripe_checkout") throw new RelayError("unsupported_settlement_mode", "Unsupported settlement mode", 400);
    const network = postgresRequiredCode(input.paymentNetwork, "paymentNetwork");
    const asset = postgresPaymentAsset(input.paymentAsset);
    if (settlementMode === "stripe_checkout" && (network !== "stripe" || asset !== "USD")) throw new RelayError("stripe_payment_channel_invalid", "Stripe Checkout channels must use the stripe network and USD", 400);
    const identifier = postgresRequiredTrimmed(input.recipientIdentifier, "recipientIdentifier");
    postgresRejectSensitivePaymentIdentifier(identifier);
    const recipientIdentifierType = postgresControlledIdentifierType(input.recipientIdentifierType);
    const transactionReferenceType = postgresControlledReferenceType(input.transactionReferenceType);
    return this.insertRow<PaymentChannel>("payment_channels", {
      id: createId("payment_channel"), code: postgresRequiredCode(input.code, "code"), displayName: postgresRequiredTrimmed(input.displayName, "displayName"),
      paymentNetwork: network, paymentAsset: asset, settlementMode, recipientIdentifierType, transactionReferenceType,
      recipientIdentifier: identifier, recipientIdentifierDisplay: postgresRequiredTrimmed(input.recipientIdentifierDisplay, "recipientIdentifierDisplay"),
      normalizedRecipientIdentifierHash: postgresSha256Text(postgresNormalizePaymentIdentifier(identifier)), paymentInstruction: postgresTrimNullable(input.paymentInstruction),
      status: "draft", createdByUserId: input.createdByUserId, createdAt: nowIso(),
    });
  }

  async setPaymentChannelStatus(id: string, status: "enabled" | "disabled"): Promise<PaymentChannel> {
    const channel = await this.getPaymentChannel(id);
    if (!channel) throw new RelayError("payment_channel_not_found", "Payment channel not found", 404);
    if (status === "enabled" && channel.status !== "draft") throw new RelayError("payment_channel_not_draft", "Only draft payment channels can be enabled", 409);
    const updated = await this.updateRow<PaymentChannel>("payment_channels", id, { status });
    return updated ?? { ...channel, status };
  }

  async createCreditProductListing(input: { productId: string; paymentChannelId: string; priceAmountUnits: number }): Promise<CreditProductListing> {
    return this.withRetriedTransaction(async (transaction) => {
      const product = await transaction.getCreditProduct(input.productId);
      const channel = await transaction.getPaymentChannel(input.paymentChannelId);
      if (!product || product.status !== "enabled") throw new RelayError("credit_product_not_enabled", "Credit product must be enabled", 409);
      if (!channel || channel.status !== "enabled" || !["manual_review", "stripe_checkout"].includes(channel.settlementMode)) throw new RelayError("payment_channel_not_enabled", "Payment channel must be enabled", 409);
      if (channel.settlementMode === "stripe_checkout" && channel.paymentAsset !== "USD") throw new RelayError("stripe_payment_asset_invalid", "Stripe Checkout listings must use USD", 409);
      const priceAmountUnits = postgresRequiredUsdSettlementUnits(input.priceAmountUnits, "priceAmountUnits");
      await transaction.query(`UPDATE "credit_product_listings" SET "status" = 'disabled' WHERE "product_id" = $1 AND "payment_channel_id" = $2 AND "status" = 'enabled'`, [product.id, channel.id]);
      return transaction.insertRow<CreditProductListing>("credit_product_listings", { id: createId("credit_product_listing"), productId: product.id, paymentChannelId: channel.id, priceAmountUnits, status: "enabled", createdAt: nowIso() });
    });
  }

  async disableCreditProductListing(id: string): Promise<CreditProductListing> {
    const listing = await this.getCreditProductListing(id);
    if (!listing) throw new RelayError("credit_product_listing_not_found", "Credit product listing not found", 404);
    const updated = await this.updateRow<CreditProductListing>("credit_product_listings", id, { status: "disabled" });
    return updated ?? { ...listing, status: "disabled" };
  }

  async switchCreditProductListingsChannel(input: { sourcePaymentChannelId: string; targetPaymentChannelId: string }): Promise<CreditProductListing[]> {
    return this.withRetriedTransaction(async (transaction) => {
      const target = await transaction.getPaymentChannel(input.targetPaymentChannelId);
      if (!target || target.status !== "enabled") throw new RelayError("payment_channel_not_enabled", "Target payment channel must be enabled", 409);
      const sourceListings = await transaction.rows<CreditProductListing>(`SELECT * FROM "credit_product_listings" WHERE "payment_channel_id" = $1 AND "status" = 'enabled' ORDER BY "created_at" ASC, "id" ASC FOR UPDATE`, [input.sourcePaymentChannelId]);
      if (sourceListings.length === 0) throw new RelayError("credit_product_listing_not_found", "Source channel has no enabled listings", 404);
      const created: CreditProductListing[] = [];
      for (const listing of sourceListings) {
        await transaction.query(`UPDATE "credit_product_listings" SET "status" = 'disabled' WHERE "id" = $1`, [listing.id]);
        created.push(await transaction.createCreditProductListing({ productId: listing.productId, paymentChannelId: target.id, priceAmountUnits: listing.priceAmountUnits }));
      }
      return created;
    });
  }

  async getPaymentChannel(id: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getPaymentChannel"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getPaymentChannel"]>>>(
      `SELECT * FROM "payment_channels" WHERE "id" = $1`,
      [id],
    );
  }

  async getPaymentChannelInstructionAttachment(id: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getPaymentChannelInstructionAttachment"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getPaymentChannelInstructionAttachment"]>>>(
      `SELECT * FROM "payment_channel_instruction_attachments" WHERE "id" = $1`,
      [id],
    );
  }

  async listPaymentChannelInstructionAttachments(paymentChannelId: string): Promise<PaymentChannelInstructionAttachment[]> {
    return this.rows<PaymentChannelInstructionAttachment>(
      `SELECT * FROM "payment_channel_instruction_attachments" WHERE "payment_channel_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
      [paymentChannelId],
    );
  }

  async createPaymentChannelInstructionAttachment(input: Omit<PaymentChannelInstructionAttachment, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<PaymentChannelInstructionAttachment> {
    return this.withRetriedTransaction(async (transaction) => {
      if (!(await transaction.getPaymentChannel(input.paymentChannelId))) throw new RelayError("payment_channel_not_found", "Payment channel not found", 404);
      postgresValidateImageAttachment(input.contentType, input.byteSize);
      const duplicate = await transaction.one<PaymentChannelInstructionAttachment>(`SELECT * FROM "payment_channel_instruction_attachments" WHERE "payment_channel_id" = $1 AND "sha256" = $2 LIMIT 1`, [input.paymentChannelId, input.sha256]);
      if (duplicate) return duplicate;
      return transaction.insertRow<PaymentChannelInstructionAttachment>("payment_channel_instruction_attachments", { ...input, id: input.id ?? createId("payment_channel_attachment"), createdAt: input.createdAt ?? nowIso() });
    });
  }

  async isEnabledPaymentChannelListed(channelId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["isEnabledPaymentChannelListed"]>>> {
    const row = await this.one<{ id: string }>(
      `SELECT channel."id"
       FROM "payment_channels" channel
       WHERE channel."id" = $1 AND channel."status" = 'enabled'
         AND EXISTS (
           SELECT 1 FROM "credit_product_listings" listing
           WHERE listing."payment_channel_id" = channel."id" AND listing."status" = 'enabled'
         )
       LIMIT 1`,
      [channelId],
    );
    return Boolean(row);
  }

  async getCreditTopup(id: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getCreditTopup"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getCreditTopup"]>>>(
      `SELECT * FROM "credit_topups" WHERE "id" = $1`,
      [id],
    );
  }

  async attachStripeCheckoutSession(input: { topupId: string; checkoutSessionId: string }): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      const topup = await transaction.getCreditTopup(input.topupId);
      if (!topup || topup.settlementMode !== "stripe_checkout" || topup.paymentNetwork !== "stripe") {
        throw new RelayError("stripe_topup_configuration_invalid", "Credit topup is not a Stripe Checkout payment", 409);
      }
      const checkoutSessionId = postgresRequiredTrimmed(input.checkoutSessionId, "checkoutSessionId");
      if (topup.transactionReference) {
        if (topup.transactionReference !== checkoutSessionId) throw new RelayError("stripe_checkout_session_mismatch", "Stripe Checkout Session does not match the topup", 409);
        return topup;
      }
      if (topup.status !== "pending_payment") throw new RelayError("credit_topup_not_pending_payment", "Stripe Checkout topup is not pending payment", 409);
      const referenceHash = postgresSha256Text(postgresNormalizePaymentIdentifier(checkoutSessionId));
      const duplicate = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "credit_topups"
         WHERE "payment_network" = 'stripe' AND "normalized_transaction_reference_hash" = $1 AND "id" <> $2
         LIMIT 1`,
        [referenceHash, topup.id],
      );
      if (duplicate) throw new RelayError("duplicate_transaction_reference", "Stripe Checkout Session has already been used", 409);
      const updated = await transaction.query<CreditTopup>(
        `UPDATE "credit_topups"
         SET "transaction_reference" = $2, "normalized_transaction_reference_hash" = $3,
             "transaction_reference_tail" = $4, "updated_at" = $5
         WHERE "id" = $1 AND "status" = 'pending_payment' RETURNING *`,
        [topup.id, checkoutSessionId, referenceHash, checkoutSessionId.slice(-8), nowIso()],
      );
      if (!updated.rows[0]) throw new RelayError("credit_topup_not_pending_payment", "Stripe Checkout topup is not pending payment", 409);
      return mapPostgresRow<CreditTopup>(updated.rows[0]);
    });
  }

  async recordStripeCreditTopupTerminal(input: { topupId: string; checkoutSessionId: string; status: "payment_failed" | "expired"; webhookEvent: { eventId: string; eventType: string; livemode: boolean } }): Promise<CreditTopup> {
    return this.withRetriedTransaction(async (transaction) => {
      const checkoutSessionId = postgresRequiredTrimmed(input.checkoutSessionId, "checkoutSessionId");
      const now = nowIso();
      const priorEvent = await transaction.getStripeWebhookEvent(input.webhookEvent.eventId);
      if (priorEvent && (priorEvent.eventType !== input.webhookEvent.eventType || priorEvent.livemode !== input.webhookEvent.livemode || priorEvent.topupId !== input.topupId || priorEvent.planPurchaseOrderId !== null || priorEvent.checkoutSessionTail !== checkoutSessionId.slice(-8) || priorEvent.status === "ignored")) {
        throw new RelayError("stripe_webhook_event_mismatch", "Stripe webhook Event business binding does not match", 409);
      }
      const topup = await transaction.one<CreditTopup>(`SELECT * FROM "credit_topups" WHERE "id" = $1 FOR UPDATE`, [input.topupId]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      if (topup.settlementMode !== "stripe_checkout" || topup.paymentNetwork !== "stripe") throw new RelayError("stripe_topup_configuration_invalid", "Credit topup is not a Stripe Checkout payment", 409);
      if (!topup.transactionReference || topup.transactionReference !== checkoutSessionId) throw new RelayError("stripe_checkout_session_mismatch", "Stripe Checkout Session does not match the topup", 409);
      if (!priorEvent) {
        await transaction.insertRow<StripeWebhookEvent>("stripe_webhook_events", {
          eventId: input.webhookEvent.eventId,
          eventType: input.webhookEvent.eventType,
          livemode: input.webhookEvent.livemode,
          checkoutSessionTail: checkoutSessionId.slice(-8),
          topupId: input.topupId,
          planPurchaseOrderId: null,
          status: "received",
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          processedAt: null,
        });
      }
      if (topup.status === "pending_payment") {
        const terminalColumn = input.status === "payment_failed" ? "payment_failed_at" : "expired_at";
        const updated = await transaction.query<CreditTopup>(
          `UPDATE "credit_topups" SET "status" = $2, "${terminalColumn}" = $3, "updated_at" = $3 WHERE "id" = $1 AND "status" = 'pending_payment' RETURNING *`,
          [topup.id, input.status, now],
        );
        if (!updated.rows[0]) throw new RelayError("credit_topup_terminal_transition_failed", "Credit topup terminal transition failed", 409);
      }
      await transaction.query(`UPDATE "stripe_webhook_events" SET "status" = 'succeeded', "error_code" = NULL, "updated_at" = $2, "processed_at" = $2 WHERE "event_id" = $1`, [input.webhookEvent.eventId, now]);
      return (await transaction.getCreditTopup(topup.id))!;
    });
  }

  async getStripeWebhookEvent(eventId: string): Promise<StripeWebhookEvent | undefined> {
    return this.one<StripeWebhookEvent>(`SELECT * FROM "stripe_webhook_events" WHERE "event_id" = $1`, [eventId]);
  }

  async recordStripeWebhookIgnored(input: { eventId: string; eventType: string; livemode: boolean; checkoutSessionId?: string | null; topupId?: string | null; planPurchaseOrderId?: string | null; reason: string }): Promise<StripeWebhookEvent> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getStripeWebhookEvent(input.eventId);
      if (existing) return existing;
      const topupId = input.topupId && await transaction.getCreditTopup(input.topupId) ? input.topupId : null;
      const planPurchaseOrderId = input.planPurchaseOrderId && await transaction.getPlanPurchaseOrder(input.planPurchaseOrderId) ? input.planPurchaseOrderId : null;
      if (topupId && planPurchaseOrderId) throw new RelayError("stripe_webhook_resource_conflict", "Stripe webhook Event cannot bind multiple business resources", 409);
      const now = nowIso();
      await transaction.insertRow<StripeWebhookEvent>("stripe_webhook_events", {
        eventId: input.eventId,
        eventType: input.eventType,
        livemode: input.livemode,
        checkoutSessionTail: input.checkoutSessionId?.slice(-8) ?? null,
        topupId,
        planPurchaseOrderId,
        status: "ignored",
        errorCode: postgresRequiredTrimmed(input.reason, "reason"),
        createdAt: now,
        updatedAt: now,
        processedAt: now,
      });
      return (await transaction.getStripeWebhookEvent(input.eventId))!;
    });
  }

  async recordStripeWebhookFailure(input: { eventId: string; eventType: string; livemode: boolean; checkoutSessionId?: string | null; topupId?: string | null; planPurchaseOrderId?: string | null; errorCode: string }): Promise<StripeWebhookEvent> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getStripeWebhookEvent(input.eventId);
      if (existing?.status === "succeeded" || existing?.status === "ignored") return existing;
      const now = nowIso();
      const errorCode = postgresRequiredTrimmed(input.errorCode, "errorCode");
      if (existing) {
        const updated = await transaction.query<StripeWebhookEvent>(
          `UPDATE "stripe_webhook_events" SET "status" = 'failed', "error_code" = $2, "updated_at" = $3, "processed_at" = NULL WHERE "event_id" = $1 RETURNING *`,
          [input.eventId, errorCode, now],
        );
        return mapPostgresRow<StripeWebhookEvent>(updated.rows[0]!);
      }
      const topupId = input.topupId && await transaction.getCreditTopup(input.topupId) ? input.topupId : null;
      const planPurchaseOrderId = input.planPurchaseOrderId && await transaction.getPlanPurchaseOrder(input.planPurchaseOrderId) ? input.planPurchaseOrderId : null;
      if (topupId && planPurchaseOrderId) throw new RelayError("stripe_webhook_resource_conflict", "Stripe webhook Event cannot bind multiple business resources", 409);
      await transaction.insertRow<StripeWebhookEvent>("stripe_webhook_events", {
        eventId: input.eventId,
        eventType: input.eventType,
        livemode: input.livemode,
        checkoutSessionTail: input.checkoutSessionId?.slice(-8) ?? null,
        topupId,
        planPurchaseOrderId,
        status: "failed",
        errorCode,
        createdAt: now,
        updatedAt: now,
        processedAt: null,
      });
      return (await transaction.getStripeWebhookEvent(input.eventId))!;
    });
  }

  async completeStripeCreditTopup(input: { topupId: string; checkoutSessionId: string; paymentIntentId: string | null; amountUnits: number; currency: string; webhookEvent?: { eventId: string; eventType: string; livemode: boolean } }): Promise<{ topup: CreditTopup; card: Card | null; ledgerEvent: CreditLedgerEvent | null; account: CreditAccount | null; replayed: boolean }> {
    return this.withRetriedTransaction(async (transaction) => {
      const priorEvent = input.webhookEvent ? await transaction.getStripeWebhookEvent(input.webhookEvent.eventId) : undefined;
      if (priorEvent && input.webhookEvent && (priorEvent.eventType !== input.webhookEvent.eventType || priorEvent.livemode !== input.webhookEvent.livemode)) {
        throw new RelayError("stripe_webhook_event_mismatch", "Stripe webhook Event identity does not match", 409);
      }
      if (priorEvent && (priorEvent.topupId !== input.topupId || priorEvent.planPurchaseOrderId !== null || priorEvent.checkoutSessionTail !== input.checkoutSessionId.slice(-8) || priorEvent.status === "ignored")) {
        throw new RelayError("stripe_webhook_event_mismatch", "Stripe webhook Event business binding does not match", 409);
      }
      if (input.webhookEvent && !priorEvent) {
        const now = nowIso();
        await transaction.insertRow<StripeWebhookEvent>("stripe_webhook_events", {
          eventId: input.webhookEvent.eventId,
          eventType: input.webhookEvent.eventType,
          livemode: input.webhookEvent.livemode,
          checkoutSessionTail: input.checkoutSessionId.slice(-8),
          topupId: input.topupId,
          planPurchaseOrderId: null,
          status: "received",
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          processedAt: null,
        });
      }
      const topup = await transaction.one<CreditTopup>(`SELECT * FROM "credit_topups" WHERE "id" = $1 FOR UPDATE`, [input.topupId]);
      if (!topup) throw new RelayError("credit_topup_not_found", "Credit topup not found", 404);
      const checkoutSessionId = postgresRequiredTrimmed(input.checkoutSessionId, "checkoutSessionId");
      const currency = normalizeStripeCurrency(input.currency);
      const amountUnits = postgresRequiredUsdSettlementUnits(input.amountUnits, "amountUnits");
      if (topup.settlementMode !== "stripe_checkout" || topup.paymentNetwork !== "stripe") throw new RelayError("stripe_topup_configuration_invalid", "Credit topup is not a Stripe Checkout payment", 409);
      if (topup.transactionReference && topup.transactionReference !== checkoutSessionId) throw new RelayError("stripe_checkout_session_mismatch", "Stripe Checkout Session does not match the topup", 409);
      if (currency !== "USD" || topup.paymentAsset !== "USD" || amountUnits !== topup.expectedPaymentAmountUnits) throw new RelayError("stripe_payment_amount_mismatch", "Stripe payment amount or currency does not match the topup", 409);
      const finalize = async (result: { topup: CreditTopup; card: Card | null; ledgerEvent: CreditLedgerEvent | null; account: CreditAccount | null; replayed: boolean }) => {
        if (input.webhookEvent && priorEvent?.status !== "succeeded") {
          const processedAt = nowIso();
          await transaction.query(`UPDATE "stripe_webhook_events" SET "status" = 'succeeded', "error_code" = NULL, "updated_at" = $2, "processed_at" = $2 WHERE "event_id" = $1`, [input.webhookEvent.eventId, processedAt]);
        }
        if (!result.replayed) {
          await transaction.audit({ actor: { actorType: "system", actorId: "stripe" }, source: "system", requestId: input.webhookEvent?.eventId ?? null, action: "credit_topup.stripe_checkout_complete", resource: { resourceType: "credit_topup", resourceId: result.topup.id }, result: "success", metadata: { topupId: result.topup.id, initiatedBy: result.topup.userId, checkoutSessionTail: checkoutSessionId.slice(-8), paymentIntentTail: input.paymentIntentId?.slice(-8) ?? null, amountUnits, currency } });
        }
        return result;
      };
      if (topup.status === "credited" && topup.ledgerEventId) {
        const ledgerEvent = await transaction.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "id" = $1`, [topup.ledgerEventId]);
        return finalize({ topup, card: null, ledgerEvent: ledgerEvent ?? null, account: topup.creditAccountId ? await transaction.getCreditAccount(topup.creditAccountId) ?? null : null, replayed: true });
      }
      if (topup.status === "fulfilled" && topup.cardId) {
        const card = await transaction.getCard(topup.cardId);
        if (!card) throw new RelayError("credit_topup_card_missing", "Fulfilled topup Card is missing", 500);
        const ledgerEvent = await transaction.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "card_id" = $1 LIMIT 1`, [card.id]);
        return finalize({ topup, card, ledgerEvent: ledgerEvent ?? null, account: ledgerEvent ? await transaction.getCreditAccount(ledgerEvent.accountId) ?? null : null, replayed: true });
      }
      if (["expired", "payment_failed", "cancelled", "rejected", "reversed"].includes(topup.status)) {
        return finalize({ topup, card: null, ledgerEvent: null, account: null, replayed: true });
      }
      if (topup.status !== "pending_payment") throw new RelayError("credit_topup_not_pending_payment", "Stripe Checkout topup is not pending payment", 409);
      const referenceHash = postgresSha256Text(postgresNormalizePaymentIdentifier(checkoutSessionId));
      const duplicate = await transaction.one<{ id: string }>(`SELECT "id" FROM "credit_topups" WHERE "payment_network" = 'stripe' AND "normalized_transaction_reference_hash" = $1 AND "id" <> $2 LIMIT 1`, [referenceHash, topup.id]);
      if (duplicate) throw new RelayError("duplicate_transaction_reference", "Stripe Checkout Session has already been used", 409);
      const now = nowIso();
      if (topup.useImmediately !== null) {
        const card = await transaction.createCard({ cardType: "credit", ownerUserId: topup.userId, creditProductId: topup.productId, creditAmountUnits: topup.creditedAmountUnits, createdAt: now });
        const used = topup.useImmediately ? await transaction.useCard({ cardId: card.id, ownerUserId: topup.userId }) : null;
        await transaction.query(
          `UPDATE "credit_topups" SET "status" = 'fulfilled', "confirmed_received_amount_units" = $2,
             "transaction_reference" = $3, "normalized_transaction_reference_hash" = $4, "transaction_reference_tail" = $5,
             "payment_submitted_at" = $6, "card_id" = $7, "credited_at" = $6, "reviewed_at" = $6,
             "review_note" = 'verified Stripe Checkout payment', "updated_at" = $6 WHERE "id" = $1`,
          [topup.id, amountUnits, checkoutSessionId, referenceHash, checkoutSessionId.slice(-8), now, card.id],
        );
        return finalize({ topup: (await transaction.getCreditTopup(topup.id))!, card: used?.card ?? card, ledgerEvent: used?.cardType === "credit" ? used.ledgerEvent : null, account: used?.cardType === "credit" ? used.account : null, replayed: false });
      }
      if (!topup.creditAccountId || !topup.scopeRef) throw new RelayError("credit_account_not_found", "Credit account is missing", 404);
      const account = await transaction.getCreditAccount(topup.creditAccountId);
      if (!account || account.status !== "active" || account.scopeRef !== topup.scopeRef || topup.scopeRef !== userScopeRef(topup.userId)) throw new RelayError("credit_account_not_found", "Active topup credit account not found", 404);
      const ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "top_up", amountUnits: topup.creditedAmountUnits, transferId: null, relatedEventId: null, planSubscriptionId: null, billingEventId: null, relatedTopupId: topup.id, fromAccountId: null, toAccountId: account.id, reason: `credit_topup:${topup.id}`, actorUserId: null });
      await transaction.query(
        `UPDATE "credit_topups" SET "status" = 'credited', "confirmed_received_amount_units" = $2,
           "transaction_reference" = $3, "normalized_transaction_reference_hash" = $4, "transaction_reference_tail" = $5,
           "payment_submitted_at" = $6, "ledger_event_id" = $7, "credited_at" = $6, "reviewed_at" = $6,
           "review_note" = 'verified Stripe Checkout payment', "updated_at" = $6 WHERE "id" = $1`,
        [topup.id, amountUnits, checkoutSessionId, referenceHash, checkoutSessionId.slice(-8), now, ledgerEvent.id],
      );
      return finalize({ topup: (await transaction.getCreditTopup(topup.id))!, card: null, ledgerEvent, account: await transaction.getCreditAccount(account.id) ?? account, replayed: false });
    });
  }

  async createCreditLedgerEvent(input: Omit<CreditLedgerEvent, "id" | "createdAt" | "relatedTopupId" | "cardId" | "authorityPurchaseId"> & { id?: string; createdAt?: string; relatedTopupId?: string | null; cardId?: string | null; authorityPurchaseId?: string | null; allowNegativeBalance?: boolean }): Promise<CreditLedgerEvent> {
    return this.withRetriedTransaction(async (transaction) => {
      const { allowNegativeBalance = false, ...eventInput } = input;
      const row: CreditLedgerEvent = {
        id: input.id ?? createId("ledger"),
        createdAt: input.createdAt ?? nowIso(),
        relatedTopupId: input.relatedTopupId ?? null,
        cardId: input.cardId ?? null,
        authorityPurchaseId: input.authorityPurchaseId ?? null,
        ...eventInput,
      };
      if (!Number.isSafeInteger(row.amountUnits) || row.amountUnits === 0) throw new RelayError("invalid_credit_amount", "Credit ledger amount must be a non-zero safe integer", 400);
      const account = await transaction.one<CreditAccount>(`SELECT * FROM "credit_accounts" WHERE "id" = $1 FOR UPDATE`, [row.accountId]);
      if (!account) throw new RelayError("credit_account_not_found", `Credit account ${row.accountId} not found`, 404);
      if (account.status !== "active") throw new RelayError("credit_account_inactive", "Credit account must be active", 409);
      const heldRow = row.amountUnits < 0 && !allowNegativeBalance ? await transaction.one<{ heldUnits: number | string }>(
        `SELECT (
           COALESCE((SELECT SUM("held_units") FROM "usage_reservations" WHERE "credit_account_id" = $1 AND "status" IN ('active', 'reconciling')), 0)
         )::bigint AS "heldUnits"`,
        [row.accountId],
      ) : null;
      const heldUnits = heldRow ? safePostgresInteger(heldRow.heldUnits, "credit_held_units_invalid") : 0;
      if (!allowNegativeBalance && row.amountUnits < 0 && account.balanceSnapUnits - heldUnits + row.amountUnits < 0) {
        throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient", 402);
      }
      const inserted = await transaction.insertRow<CreditLedgerEvent>("credit_ledger_events", row);
      const updated = await transaction.query(
        `UPDATE "credit_accounts"
         SET "balance_snap_units" = "balance_snap_units" + $2,
             "balance_snap_ledger_event_id" = $3,
             "balance_snap_updated_at" = $4,
             "updated_at" = $4
         WHERE "id" = $1 RETURNING "id"`,
        [row.accountId, row.amountUnits, row.id, row.createdAt],
      );
      if (!updated.rows[0]) throw new RelayError("credit_account_not_found", "Credit account could not be updated", 404);
      return inserted;
    });
  }

  async transferCredit(input: { fromAccountId: string; toAccountId: string; amountUnits: number; actorUserId: string; reason?: string | null; transferId?: string }): Promise<{ outEvent: CreditLedgerEvent; inEvent: CreditLedgerEvent }> {
    if (!Number.isSafeInteger(input.amountUnits) || input.amountUnits <= 0) throw new RelayError("invalid_credit_amount", "Transfer amount units must be a positive safe integer", 400);
    if (input.fromAccountId === input.toAccountId) throw new RelayError("credit_transfer_same_account", "Credit transfer accounts must be different", 400);
    return this.withRetriedTransaction(async (transaction) => {
      const ids = [input.fromAccountId, input.toAccountId].sort();
      const locked = await transaction.rows<CreditAccount>(
        `SELECT * FROM "credit_accounts" WHERE "id" IN ($1, $2) ORDER BY "id" ASC FOR UPDATE`,
        ids,
      );
      const from = locked.find((account) => account.id === input.fromAccountId);
      const to = locked.find((account) => account.id === input.toAccountId);
      if (!from || !to) throw new RelayError("credit_account_not_found", "Credit account not found", 404);
      if (from.status !== "active" || to.status !== "active") throw new RelayError("credit_account_inactive", "Credit accounts must be active", 409);
      const policy = await transaction.getCreditTransferPolicy(from.scopeRef as ScopeRef);
      if (policy && !policy.transferOutEnabled) throw new RelayError("credit_transfer_out_disabled", "Credit transfer out is disabled for this scope", 403);
      if (from.balanceSnapUnits < input.amountUnits) throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient", 402);
      const transferId = input.transferId ?? createId("transfer");
      const outEvent = await transaction.createCreditLedgerEvent({
        accountId: from.id, eventType: "transfer_out", amountUnits: -input.amountUnits, transferId,
        relatedEventId: null, planSubscriptionId: null, billingEventId: null,
        fromAccountId: from.id, toAccountId: to.id, reason: input.reason ?? null, actorUserId: input.actorUserId,
      });
      const inEvent = await transaction.createCreditLedgerEvent({
        accountId: to.id, eventType: "transfer_in", amountUnits: input.amountUnits, transferId,
        relatedEventId: outEvent.id, planSubscriptionId: null, billingEventId: null,
        fromAccountId: from.id, toAccountId: to.id, reason: input.reason ?? null, actorUserId: input.actorUserId,
      });
      return { outEvent, inEvent };
    });
  }

  async createCard(input: { cardType: "plan" | "credit"; issuanceType?: CardIssuanceType; ownerUserId: string; planId?: string | null; creditProductId?: string | null; creditAmountUnits?: number | null; replacesCardId?: string | null; id?: string; createdAt?: string; expiresAt?: string }): Promise<Card> {
    const createdAt = input.createdAt ?? nowIso();
    const card: Card = {
      id: input.id ?? createId("card"), cardType: input.cardType, issuanceType: input.issuanceType ?? "purchase",
      ownerUserId: input.ownerUserId, planId: input.planId ?? null, creditProductId: input.creditProductId ?? null,
      creditAmountUnits: input.creditAmountUnits ?? null, createdAt, usedAt: null, invalidatedAt: null,
      invalidationReason: null, expiresAt: input.expiresAt ?? new Date(Date.parse(createdAt) + 63_072_000_000).toISOString(),
      replacesCardId: input.replacesCardId ?? null,
    };
    if (card.cardType === "plan" && (!card.planId || card.creditProductId || card.creditAmountUnits !== null || card.replacesCardId === card.id)) throw new RelayError("invalid_plan_card", "Plan Card shape is invalid", 400);
    if (card.cardType === "credit" && (card.planId || !card.creditProductId || !Number.isSafeInteger(card.creditAmountUnits) || (card.creditAmountUnits ?? 0) <= 0 || card.replacesCardId)) throw new RelayError("invalid_credit_card", "Credit Card shape is invalid", 400);
    return this.insertRow<Card>("cards", card);
  }

  async grantAdminCard(input: Parameters<ApplicationOperationPort["grantAdminCard"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["grantAdminCard"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      if (input.senderUserId === input.recipientUserId) throw new RelayError("card_recipient_same_as_sender", "Card recipient must be different from sender", 400);
      const referenceCode = postgresNormalizeCardTransferReferenceCode(input.referenceCode);
      if (!referenceCode) throw new RelayError("card_admin_reference_required", "Admin Card reference code is required", 400);
      const note = postgresNormalizeCardTransferNote(input.note);
      const now = nowIso();
      const sender = await transaction.getUser(input.senderUserId);
      if (!sender || sender.status !== "enabled") throw new RelayError("card_sender_not_found", "Enabled Admin Card sender not found", 404);
      const recipient = await transaction.getUser(input.recipientUserId);
      if (!recipient || recipient.status !== "enabled") throw new RelayError("card_recipient_not_found", "Enabled Card recipient not found", 404);
      const expiresAt = postgresNormalizeAdminCardExpiration(input.expiresAt, now);
      let card: Card;
      if (input.cardType === "plan") {
        const plan = input.planId ? await transaction.getPlan(input.planId) : undefined;
        if (!plan || plan.planStatus !== "enabled" || plan.billingMode !== "prepaid" || plan.durationSeconds <= 0 || !(await transaction.isPlanVisibleToUser(plan, input.recipientUserId))) {
          throw new RelayError("admin_plan_card_not_available", "Enabled prepaid Plan visible to the recipient is required", 409);
        }
        card = await transaction.createCard({ cardType: "plan", issuanceType: "admin_grant", ownerUserId: input.senderUserId, planId: plan.id, expiresAt, createdAt: now });
      } else if (input.cardType === "credit") {
        const product = input.creditProductId ? await transaction.getCreditProduct(input.creditProductId) : undefined;
        if (!product || product.status !== "enabled") throw new RelayError("admin_credit_card_not_available", "Enabled Credit Product is required", 409);
        card = await transaction.createCard({ cardType: "credit", issuanceType: "admin_grant", ownerUserId: input.senderUserId, creditProductId: product.id, creditAmountUnits: product.creditedAmountUnits, expiresAt, createdAt: now });
      } else {
        throw new RelayError("card_type_not_supported", "Admin Card type is not supported", 400);
      }
      const moved = await transaction.query(
        `UPDATE "cards" SET "owner_user_id" = $2
         WHERE "id" = $1 AND "owner_user_id" = $3 AND "used_at" IS NULL
           AND "invalidated_at" IS NULL AND "expires_at" > $4`,
        [card.id, input.recipientUserId, input.senderUserId, now],
      );
      if ((moved.rowCount ?? 0) !== 1) throw new RelayError("card_not_available", "Card was already sent or used", 409);
      const transfer = await transaction.insertRow<CardTransfer>("card_transfers", {
        id: createId("card_transfer"), cardId: card.id, fromUserId: input.senderUserId,
        toUserId: input.recipientUserId, referenceCode, note, createdAt: now,
      });
      await transaction.audit({
        actor: { actorType: "user", actorId: input.senderUserId }, action: "card.admin_grant",
        resource: { resourceType: "card", resourceId: card.id }, result: "success", source: "owner",
        requestId: input.requestId, metadata: { transferId: transfer.id, cardId: card.id, cardType: card.cardType, issuanceType: card.issuanceType, fromUserId: input.senderUserId, toUserId: input.recipientUserId, planId: card.planId, creditProductId: card.creditProductId, creditAmountUnits: card.creditAmountUnits, expiresAt: card.expiresAt, referenceCode },
      });
      return { card: (await transaction.getCard(card.id))!, transfer };
    });
  }

  async createAdminGrantBatch(input: Parameters<ApplicationOperationPort["createAdminGrantBatch"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["createAdminGrantBatch"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const targets = [...new Set(input.targetUserIds.map((id) => id.trim()).filter(Boolean))];
      if (!targets.length || targets.length > 500) throw new RelayError("invalid_batch_grant_targets", "Select between 1 and 500 users", 400);
      const referenceCode = postgresNormalizeCardTransferReferenceCode(input.referenceCode);
      if (!referenceCode) throw new RelayError("card_admin_reference_required", "Admin Card reference code is required", 400);
      const note = postgresNormalizeCardTransferNote(input.note);
      const fallbackToPlanCard = input.actionType === "subscription" && input.fallbackToPlanCard === true;
      const idempotencyKey = postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key");
      const requestHash = postgresSha256Text(JSON.stringify({ actionType: input.actionType, targetUserIds: [...targets].sort(), planId: input.planId ?? null, creditProductId: input.creditProductId ?? null, expiresAt: input.expiresAt ?? null, referenceCode, note, fallbackToPlanCard }));
      const keyHash = postgresSha256Text(idempotencyKey);
      const existing = await transaction.one<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantBatches"]>>[number]>(
        `SELECT * FROM "admin_grant_batches" WHERE "requested_by_user_id" = $1 AND "idempotency_key_hash" = $2`,
        [input.requestedByUserId, keyHash],
      );
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RelayError("idempotency_conflict", "Idempotency key was already used with a different request", 409);
        const detail = await transaction.getAdminGrantBatchDetail(existing.id);
        if (!detail) throw new RelayError("admin_grant_batch_not_found", "Admin grant batch not found", 500);
        return detail;
      }
      const now = nowIso();
      const expiresAt = input.actionType === "subscription" ? null : postgresNormalizeAdminCardExpiration(input.expiresAt, now);
      if (fallbackToPlanCard) {
        const plan = input.planId ? await transaction.getPlan(input.planId) : undefined;
        if (!plan || plan.planStatus !== "enabled" || plan.billingMode !== "prepaid") throw new RelayError("admin_batch_fallback_plan_not_available", "Fallback Plan Cards require an enabled prepaid Plan", 409);
      }
      const batch = await transaction.insertRow<Awaited<ReturnType<ApplicationOperationPort["listAdminGrantBatches"]>>[number]>("admin_grant_batches", {
        id: createId("grant_batch"), actionType: input.actionType, referenceCode, planId: input.planId ?? null,
        creditProductId: input.creditProductId ?? null, expiresAt, note, fallbackToPlanCard: fallbackToPlanCard ? 1 : 0,
        requestedByUserId: input.requestedByUserId, idempotencyKeyHash: keyHash, requestHash, createdAt: now, completedAt: null,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: input.requestedByUserId }, action: "admin_grant_batch.create", resource: { resourceType: "admin_grant_batch", resourceId: batch.id }, result: "success", source: "owner", requestId: input.requestId, metadata: { batchId: batch.id, actionType: batch.actionType, planId: batch.planId, creditProductId: batch.creditProductId, targetCount: targets.length, referenceCode } });
      for (const targetUserId of targets) {
        const processedAt = nowIso();
        let item: { id: string; batchId: string; targetUserId: string; outcome: string; reasonCode: string | null; cardId: string | null; subscriptionId: string | null; processedAt: string };
        try {
          const target = await transaction.getUser(targetUserId);
          if (!target || target.status !== "enabled") throw new RelayError("card_recipient_not_found", "Enabled grant recipient not found", 404);
          if (input.actionType === "subscription") {
            const existingSubscription = await transaction.one<{ id: string }>(
              `SELECT "id" FROM "plan_subscriptions" WHERE "scope_ref" = $1 AND "plan_id" = $2 AND "subscription_lifecycle" = 'active' LIMIT 1`,
              [userScopeRef(targetUserId), input.planId],
            );
            if (existingSubscription && fallbackToPlanCard) {
              const result = await transaction.grantAdminCard({ cardType: "plan", senderUserId: input.requestedByUserId, recipientUserId: targetUserId, planId: input.planId ?? null, expiresAt: null, referenceCode, note, ...(input.requestId !== undefined ? { requestId: input.requestId } : {}) });
              item = { id: createId("grant_item"), batchId: batch.id, targetUserId, outcome: "success", reasonCode: "card_issued_for_existing_subscription", cardId: result.card.id, subscriptionId: null, processedAt };
            } else if (existingSubscription) {
              item = { id: createId("grant_item"), batchId: batch.id, targetUserId, outcome: "skipped", reasonCode: "existing_plan_subscription", cardId: null, subscriptionId: null, processedAt };
            } else {
              const result = await transaction.createPlanSubscription({ planId: input.planId!, scopeRef: userScopeRef(targetUserId), source: "admin_grant", purchasedByUserId: input.requestedByUserId, priority: 100, effectiveStart: processedAt });
              item = { id: createId("grant_item"), batchId: batch.id, targetUserId, outcome: "success", reasonCode: null, cardId: null, subscriptionId: result.id, processedAt };
            }
          } else {
            const result = await transaction.grantAdminCard({ cardType: input.actionType === "plan_card" ? "plan" : "credit", senderUserId: input.requestedByUserId, recipientUserId: targetUserId, planId: input.planId ?? null, creditProductId: input.creditProductId ?? null, expiresAt, referenceCode, note, ...(input.requestId !== undefined ? { requestId: input.requestId } : {}) });
            item = { id: createId("grant_item"), batchId: batch.id, targetUserId, outcome: "success", reasonCode: null, cardId: result.card.id, subscriptionId: null, processedAt };
          }
        } catch (error) {
          item = { id: createId("grant_item"), batchId: batch.id, targetUserId, outcome: "failed", reasonCode: error instanceof RelayError ? error.code : "batch_grant_failed", cardId: null, subscriptionId: null, processedAt };
        }
        await transaction.insertRow("admin_grant_batch_items", item);
      }
      await transaction.query(`UPDATE "admin_grant_batches" SET "completed_at" = $2 WHERE "id" = $1`, [batch.id, nowIso()]);
      const detail = await transaction.getAdminGrantBatchDetail(batch.id);
      if (!detail) throw new RelayError("admin_grant_batch_not_found", "Admin grant batch was not created", 500);
      return detail;
    });
  }

  async sendCard(input: { cardId: string; fromUserId: string; toUserId: string; referenceCode?: string | null; note?: string | null }): Promise<Card> {
    if (input.fromUserId === input.toUserId) throw new RelayError("card_recipient_same_as_sender", "Card recipient must be different from sender", 400);
    const referenceCode = postgresNormalizeCardTransferReferenceCode(input.referenceCode);
    const note = postgresNormalizeCardTransferNote(input.note);
    return this.withRetriedTransaction(async (transaction) => {
      if (referenceCode && !(await transaction.canUserSetCardReferenceCode(input.fromUserId))) throw new RelayError("card_reference_code_forbidden", "Reference code is only available to Team Owners", 403);
      const recipient = await transaction.getUser(input.toUserId);
      if (!recipient || recipient.status !== "enabled") throw new RelayError("card_recipient_not_found", "Enabled Card recipient not found", 404);
      const now = nowIso();
      const card = await transaction.one<Card>(
        `SELECT * FROM "cards" WHERE "id" = $1 FOR UPDATE`,
        [input.cardId],
      );
      if (!card || card.ownerUserId !== input.fromUserId || card.usedAt !== null || card.invalidatedAt !== null || card.expiresAt <= now) throw new RelayError("card_not_available", "Available Card owned by sender not found", 409);
      const replacement = await transaction.one<{ id: string }>(`SELECT "id" FROM "cards" WHERE "replaces_card_id" = $1 LIMIT 1`, [card.id]);
      if (replacement) throw new RelayError("card_not_available", "Available Card owned by sender not found", 409);
      if (card.cardType === "plan") {
        const plan = card.planId ? await transaction.getPlan(card.planId) : undefined;
        if (!plan || plan.planStatus !== "enabled") throw new RelayError("plan_card_transfer_closed", "Plan Card cannot be sent after its Plan is closed or disabled", 409);
      }
      const updated = await transaction.query(
        `UPDATE "cards" SET "owner_user_id" = $2
         WHERE "id" = $1 AND "owner_user_id" = $3 AND "used_at" IS NULL
           AND "invalidated_at" IS NULL AND "expires_at" > $4
           AND NOT EXISTS (SELECT 1 FROM "cards" replacement WHERE replacement."replaces_card_id" = "cards"."id")`,
        [card.id, input.toUserId, input.fromUserId, now],
      );
      if (updated.rowCount !== 1) throw new RelayError("card_not_available", "Card was already sent or used", 409);
      const transfer = await transaction.insertRow<CardTransfer>("card_transfers", {
        id: createId("card_transfer"), cardId: card.id, fromUserId: input.fromUserId,
        toUserId: input.toUserId, referenceCode, note, createdAt: now,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: input.fromUserId }, action: "card.send", resource: { resourceType: "card", resourceId: card.id }, result: "success", source: "web", metadata: { transferId: transfer.id, cardId: card.id, cardType: card.cardType, fromUserId: input.fromUserId, toUserId: input.toUserId, referenceCode } });
      const result = await transaction.getCard(card.id);
      if (!result) throw new RelayError("card_not_found", "Card not found", 404);
      return result;
    });
  }

  async createPlanSubscription(input: Partial<PlanSubscription> & { planId: string; scopeRef: ScopeRef; effectiveStart?: string; effectiveEnd?: string | null; allowClosedPlan?: boolean }): Promise<PlanSubscription> {
    return this.withRetriedTransaction(async (transaction) => {
      const plan = await transaction.getPlan(input.planId);
      if (!plan) throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
      if (plan.planStatus !== "enabled" && !(input.allowClosedPlan && plan.planStatus === "closed")) throw new RelayError("plan_not_open_for_new_entitlements", "Plan does not accept new entitlements", 409);
      if (input.scopeRef.startsWith("key:")) throw new RelayError("plan_subscription_scope_not_supported", "Plan subscriptions only support global, team, and user scopes", 400);
      const now = nowIso();
      const effectiveStart = input.effectiveStart ?? now;
      const effectiveEnd = input.effectiveEnd === undefined ? new Date(Date.parse(effectiveStart) + plan.durationSeconds * 1000).toISOString() : input.effectiveEnd;
      const overlap = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "plan_subscriptions"
         WHERE "plan_id" = $1 AND "scope_ref" = $2 AND "subscription_lifecycle" = 'active'
           AND ($3::text IS NULL OR "effective_start" < $3)
           AND ("effective_end" IS NULL OR $4::text < "effective_end") LIMIT 1`,
        [input.planId, input.scopeRef, effectiveEnd, effectiveStart],
      );
      if (overlap) throw new RelayError("plan_subscription_overlap", "Plan subscription overlaps an active subscription", 409);
      const subscription = await transaction.insertRow<PlanSubscription>("plan_subscriptions", {
        id: input.id ?? createId("plan_sub"), planId: input.planId, source: input.source ?? "admin_grant",
        scopeRef: input.scopeRef, purchasedByUserId: input.purchasedByUserId ?? null,
        fundingAccountId: input.fundingAccountId ?? null, originCardId: input.originCardId ?? null,
        priority: input.priority ?? 100, effectiveStart, effectiveEnd,
        subscriptionLifecycle: input.subscriptionLifecycle ?? "active", createdAt: input.createdAt ?? now, updatedAt: now,
      });
      return subscription;
    });
  }

  async updatePlanSubscription(id: string, input: Partial<Omit<PlanSubscription, "id" | "createdAt" | "updatedAt">>): Promise<PlanSubscription | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getPlanSubscription(id);
      if (!existing) return undefined;
      if (input.originCardId !== undefined && input.originCardId !== existing.originCardId) throw new RelayError("origin_card_immutable", "Subscription origin Card cannot be changed", 409);
      if (existing.originCardId && input.planId !== undefined && input.planId !== existing.planId) throw new RelayError("origin_card_subscription_immutable", "Card-origin Subscription Plan cannot be changed", 409);
      const scopeRef = (input.scopeRef ?? existing.scopeRef) as ScopeRef;
      if (parseScopeRef(scopeRef).scopeType === "key") throw new RelayError("plan_subscription_scope_not_supported", "Plan subscriptions only support global, team, and user scopes", 400);
      const plan = await transaction.getPlan(input.planId ?? existing.planId);
      if (!plan) throw new RelayError("plan_not_found", `Plan ${input.planId ?? existing.planId} not found`, 404);
      const changesEntitlement = (input.planId !== undefined && input.planId !== existing.planId)
        || (input.scopeRef !== undefined && input.scopeRef !== existing.scopeRef)
        || (input.effectiveStart !== undefined && input.effectiveStart !== existing.effectiveStart)
        || (input.effectiveEnd !== undefined && input.effectiveEnd !== existing.effectiveEnd)
        || (input.subscriptionLifecycle !== undefined && input.subscriptionLifecycle !== existing.subscriptionLifecycle);
      if (changesEntitlement && plan.planStatus !== "enabled") throw new RelayError("plan_not_open_for_entitlement_changes", "Closed or disabled Plan entitlements cannot be extended or reassigned", 409);
      const next: PlanSubscription = {
        ...existing,
        planId: input.planId ?? existing.planId,
        source: input.source ?? existing.source,
        scopeRef,
        purchasedByUserId: input.purchasedByUserId === undefined ? existing.purchasedByUserId : input.purchasedByUserId,
        fundingAccountId: input.fundingAccountId === undefined ? existing.fundingAccountId : input.fundingAccountId,
        originCardId: existing.originCardId,
        priority: input.priority ?? existing.priority,
        effectiveStart: input.effectiveStart ?? existing.effectiveStart,
        effectiveEnd: input.effectiveEnd === undefined ? existing.effectiveEnd : input.effectiveEnd,
        subscriptionLifecycle: input.subscriptionLifecycle ?? existing.subscriptionLifecycle,
        updatedAt: nowIso(),
      };
      const overlap = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "plan_subscriptions"
         WHERE "plan_id" = $1 AND "scope_ref" = $2 AND "subscription_lifecycle" = 'active' AND "id" <> $3
           AND ($4::text IS NULL OR "effective_start" < $4)
           AND ("effective_end" IS NULL OR $5::text < "effective_end") LIMIT 1`,
        [next.planId, next.scopeRef, id, next.effectiveEnd, next.effectiveStart],
      );
      if (overlap) throw new RelayError("plan_subscription_overlap", "Plan subscription overlaps an active subscription", 409);
      const subscription = await transaction.updateRow<PlanSubscription>("plan_subscriptions", id, {
        planId: next.planId, source: next.source, scopeRef: next.scopeRef,
        purchasedByUserId: next.purchasedByUserId, fundingAccountId: next.fundingAccountId,
        priority: next.priority, effectiveStart: next.effectiveStart, effectiveEnd: next.effectiveEnd,
        subscriptionLifecycle: next.subscriptionLifecycle, updatedAt: next.updatedAt,
      });
      return subscription;
    });
  }

  async deletePlanSubscription(id: string): Promise<boolean> {
    const existing = await this.getPlanSubscription(id);
    if (!existing) return false;
    if (existing.originCardId) throw new RelayError("origin_card_subscription_immutable", "Card-origin Subscription cannot be deleted", 409);
    const result = await this.query(`DELETE FROM "plan_subscriptions" WHERE "id" = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async cancelPlanSubscription(id: string, effectiveEnd = nowIso()): Promise<PlanSubscription | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.getPlanSubscription(id);
      if (!existing) return undefined;
      if (existing.subscriptionLifecycle === "canceled") return existing;
      if (existing.subscriptionLifecycle !== "active" || (existing.effectiveEnd !== null && existing.effectiveEnd <= effectiveEnd)) throw new RelayError("plan_subscription_not_cancelable", "Only current or future active Plan subscriptions can be canceled", 409);
      const nextEnd = existing.effectiveEnd && existing.effectiveEnd < effectiveEnd ? existing.effectiveEnd : effectiveEnd;
      return transaction.updateRow<PlanSubscription>("plan_subscriptions", id, { subscriptionLifecycle: "canceled", effectiveEnd: nextEnd, updatedAt: nowIso() });
    });
  }

  async createPlanSubscriptionUnits(input: { planId: string; scopeRef: ScopeRef; units: number; source?: string; purchasedByUserId?: string | null; fundingAccountId?: string | null; paymentAccountId?: string | null; chargePurchaseAmount?: boolean; effectiveStart?: string; priority?: number }): Promise<{ subscriptions: PlanSubscription[]; ledgerEvents: CreditLedgerEvent[] }> {
    return this.withRetriedTransaction(async (transaction) => {
      const plan = await transaction.getPlan(input.planId);
      if (!plan) throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
      if (!Number.isInteger(input.units) || input.units <= 0) throw new RelayError("invalid_plan_units", "Plan subscription units must be a positive integer", 400);
      if (plan.durationSeconds <= 0) throw new RelayError("invalid_plan_duration", "Plan duration must be greater than 0", 400);
      if (input.effectiveStart && !Number.isFinite(Date.parse(input.effectiveStart))) throw new RelayError("invalid_plan_effective_start", "Plan effective start must be a valid date", 400);
      const paymentAccount = input.chargePurchaseAmount && input.paymentAccountId ? await transaction.getCreditAccount(input.paymentAccountId) : undefined;
      if (input.chargePurchaseAmount) {
        if (!paymentAccount) throw new RelayError("credit_account_not_found", "A paying credit account is required", 404);
        if (paymentAccount.status !== "active") throw new RelayError("credit_account_inactive", "Paying credit account must be active", 400);
        const balance = await transaction.getCreditAccountBalanceUnits(paymentAccount.id);
        if (balance < usdToCreditUnits(plan.purchaseAmount * input.units)) throw new RelayError("insufficient_credit_balance", "Credit balance is insufficient", 402);
      }
      const subscriptions: PlanSubscription[] = [];
      const ledgerEvents: CreditLedgerEvent[] = [];
      let periodStart = input.effectiveStart ?? nowIso();
      for (let index = 0; index < input.units; index += 1) {
        const periodEnd = postgresAddSeconds(periodStart, plan.durationSeconds);
        const subscription = await transaction.createPlanSubscription({
          planId: plan.id, scopeRef: input.scopeRef, source: input.source ?? (input.chargePurchaseAmount ? "balance_purchase" : "admin_grant"),
          purchasedByUserId: input.purchasedByUserId ?? null, fundingAccountId: input.fundingAccountId ?? null,
          priority: input.priority ?? 100, effectiveStart: periodStart, effectiveEnd: periodEnd,
        });
        subscriptions.push(subscription);
        if (input.chargePurchaseAmount && paymentAccount && plan.purchaseAmount > 0) {
          const purchaseUnits = usdToCreditUnits(plan.purchaseAmount);
          const ledgerEvent = await transaction.createCreditLedgerEvent({
            accountId: paymentAccount.id, eventType: "plan_purchase", amountUnits: -purchaseUnits,
            transferId: null, relatedEventId: null, planSubscriptionId: subscription.id, billingEventId: null,
            fromAccountId: paymentAccount.id, toAccountId: null, reason: `plan:${plan.id}`, actorUserId: input.purchasedByUserId ?? null,
          });
          ledgerEvents.push(ledgerEvent);
          if (plan.billingMode === "prepaid") await transaction.recordPrepaidSellerRevenue({
            subscription,
            sellerScopeRef: plan.scopeRef as ScopeRef,
            amountUnits: purchaseUnits,
            sourceType: "plan_purchase",
            sourceId: ledgerEvent.id,
            createdAt: ledgerEvent.createdAt,
          });
        }
        periodStart = periodEnd;
      }
      return { subscriptions, ledgerEvents };
    });
  }

  async useCard(input: { cardId: string; ownerUserId: string }): Promise<CardUseResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const usedAt = nowIso();
      const card = await transaction.one<Card>(`SELECT * FROM "cards" WHERE "id" = $1 FOR UPDATE`, [input.cardId]);
      if (!card || card.ownerUserId !== input.ownerUserId || card.usedAt !== null || card.invalidatedAt !== null || card.expiresAt <= usedAt) throw new RelayError("card_not_available", "Available unexpired Card owned by user not found", 409);
      const replacement = await transaction.one<{ id: string }>(`SELECT "id" FROM "cards" WHERE "replaces_card_id" = $1 LIMIT 1`, [card.id]);
      if (replacement) throw new RelayError("card_not_available", "Available unexpired Card owned by user not found", 409);
      const claimed = await transaction.query(`UPDATE "cards" SET "used_at" = $2 WHERE "id" = $1 AND "used_at" IS NULL AND "invalidated_at" IS NULL AND "expires_at" > $2 RETURNING "id"`, [card.id, usedAt]);
      if (!claimed.rows[0]) throw new RelayError("card_not_available", "Card was already sent or used", 409);
      let result: CardUseResult;
      if (card.cardType === "plan") {
        const plan = card.planId ? await transaction.getPlan(card.planId) : undefined;
        if (!plan || plan.billingMode !== "prepaid" || plan.durationSeconds <= 0) throw new RelayError("invalid_plan_card", "Plan Card terms are unavailable", 409);
        if (plan.planStatus === "disabled") throw new RelayError("plan_card_use_disabled", "Plan Card cannot be used after its Plan is disabled", 409);
        const subscription = await transaction.createPlanSubscription({ planId: plan.id, scopeRef: userScopeRef(input.ownerUserId), source: "card_redeem", purchasedByUserId: input.ownerUserId, originCardId: card.id, effectiveStart: usedAt, effectiveEnd: new Date(Date.parse(usedAt) + plan.durationSeconds * 1000).toISOString(), priority: 100, allowClosedPlan: true });
        const rootCard = await transaction.one<{ id: string }>(
          `WITH RECURSIVE chain AS (
             SELECT "id", "replaces_card_id" FROM "cards" WHERE "id" = $1
             UNION ALL
             SELECT parent."id", parent."replaces_card_id"
             FROM "cards" parent INNER JOIN chain child ON parent."id" = child."replaces_card_id"
           )
           SELECT "id" FROM chain WHERE "replaces_card_id" IS NULL LIMIT 1`,
          [card.id],
        );
        const purchase = rootCard ? await transaction.one<PlanPurchaseOrder>(
          `SELECT * FROM "plan_purchase_orders" WHERE "card_id" = $1 AND "status" = 'fulfilled' LIMIT 1`,
          [rootCard.id],
        ) : undefined;
        const legacyPurchase = !purchase && rootCard ? await transaction.one<CreditLedgerEvent>(
          `SELECT * FROM "credit_ledger_events" WHERE "card_id" = $1 AND "event_type" = 'card_purchase' ORDER BY "created_at", "id" LIMIT 1`,
          [rootCard.id],
        ) : undefined;
        const funding = purchase && purchase.canonicalPurchaseAmountUnits > 0
          ? { amountUnits: purchase.canonicalPurchaseAmountUnits, sourceType: "plan_purchase_order" as const, sourceId: purchase.id }
          : legacyPurchase && legacyPurchase.amountUnits < 0
            ? { amountUnits: -legacyPurchase.amountUnits, sourceType: "card_purchase" as const, sourceId: legacyPurchase.id }
            : null;
        if (funding) await transaction.recordPrepaidSellerRevenue({
          subscription,
          sellerScopeRef: plan.scopeRef as ScopeRef,
          ...funding,
          createdAt: usedAt,
        });
        result = { card: (await transaction.getCard(card.id))!, cardType: "plan", subscription };
      } else if (card.cardType === "credit") {
        if (!card.creditAmountUnits || !card.creditProductId) throw new RelayError("invalid_credit_card", "Credit Card terms are unavailable", 409);
        const scopeRef = userScopeRef(input.ownerUserId);
        const existing = await transaction.findCreditAccountForScope(scopeRef);
        if (existing && existing.status !== "active") throw new RelayError("credit_account_inactive", "Credit account is inactive", 409);
        const account = existing ?? await transaction.createCreditAccount({ scopeRef });
        const ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "card_redeem", amountUnits: card.creditAmountUnits, transferId: null, relatedEventId: null, planSubscriptionId: null, billingEventId: null, cardId: card.id, fromAccountId: null, toAccountId: account.id, reason: `credit_card:${card.id}`, actorUserId: input.ownerUserId });
        result = { card: (await transaction.getCard(card.id))!, cardType: "credit", account: (await transaction.getCreditAccount(account.id))!, ledgerEvent };
      } else {
        throw new RelayError("card_type_not_supported", "Card type is not supported", 409);
      }
      await transaction.audit({ actor: { actorType: "user", actorId: input.ownerUserId }, action: "card.use", resource: { resourceType: "card", resourceId: card.id }, result: "success", source: "web", metadata: { cardId: card.id, cardType: card.cardType, ownerUserId: input.ownerUserId } });
      return result;
    });
  }

  async getPlanPaymentListing(id: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getPlanPaymentListing"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getPlanPaymentListing"]>>>(`SELECT * FROM "plan_payment_listings" WHERE "id" = $1`, [id]);
  }

  async pagePlanPaymentListings(
    filter: Parameters<ApplicationOperationPort["pagePlanPaymentListings"]>[0] = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePlanPaymentListings"]>>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("$VALUE", `$${values.length}`));
    };
    if (filter.planId) add(`listing."plan_id" = $VALUE`, filter.planId);
    if (filter.status) add(`listing."status" = $VALUE`, filter.status);
    if (filter.paymentAsset) add(`channel."payment_asset" = $VALUE`, normalizeStripeCurrency(filter.paymentAsset));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const from = `FROM "plan_payment_listings" listing
      INNER JOIN "payment_channels" channel ON channel."id" = listing."payment_channel_id"
      INNER JOIN "plans" plan ON plan."id" = listing."plan_id" ${where}`;
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" ${from}`, values))?.count ?? 0, "postgres_plan_listing_count_invalid");
    const pageSize = normalizeDirectoryPageSize(filter.pageSize);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(filter.page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pagePlanPaymentListings"]>>["items"][number]>(
      `SELECT listing."id", listing."plan_id" AS "planId",
              listing."payment_channel_id" AS "paymentChannelId", listing."price_amount_units" AS "priceAmountUnits",
              listing."status", listing."created_at" AS "createdAt", channel."payment_asset" AS "paymentAsset",
              channel."payment_network" AS "paymentNetwork", channel."settlement_mode" AS "settlementMode",
              channel."display_name" AS "channelDisplayName", plan."name" AS "planName", plan."version" AS "planVersion"
       ${from}
       ORDER BY listing."created_at" DESC, listing."id" DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async createPlanPaymentListing(
    input: Parameters<ApplicationOperationPort["createPlanPaymentListing"]>[0],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["createPlanPaymentListing"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const plan = await transaction.getPlan(input.planId);
      const channel = await transaction.getPaymentChannel(input.paymentChannelId);
      if (!plan || plan.planStatus !== "enabled" || plan.billingMode !== "prepaid" || usdToCreditUnits(plan.purchaseAmount) <= 0) {
        throw new RelayError("plan_not_purchasable", "Plan must be enabled, prepaid, and have a positive canonical USD price", 409);
      }
      if (!channel || channel.status !== "enabled") throw new RelayError("payment_channel_not_enabled", "Payment channel must be enabled", 409);
      if (channel.settlementMode !== "stripe_checkout" || channel.paymentNetwork !== "stripe") {
        throw new RelayError("plan_payment_handler_not_supported", "This payment channel does not have an enabled Plan purchase handler", 409);
      }
      const currency = normalizeStripeCurrency(channel.paymentAsset);
      const priceAmountUnits = postgresRequiredPaymentUnits(input.priceAmountUnits, currency, "priceAmountUnits");
      stripeMinorAmountFromUnits(priceAmountUnits, currency);
      await transaction.query(
        `UPDATE "plan_payment_listings" SET "status" = 'disabled'
         WHERE "plan_id" = $1 AND "payment_channel_id" = $2 AND "status" = 'enabled'`,
        [plan.id, channel.id],
      );
      return transaction.insertRow<Awaited<ReturnType<ApplicationOperationPort["createPlanPaymentListing"]>>>("plan_payment_listings", {
        id: createId("plan_payment_listing"),
        planId: plan.id,
        paymentChannelId: channel.id,
        priceAmountUnits,
        status: "enabled",
        createdAt: nowIso(),
      });
    });
  }

  async disablePlanPaymentListing(
    id: string,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["disablePlanPaymentListing"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const listing = await transaction.getPlanPaymentListing(id);
      if (!listing) throw new RelayError("plan_payment_listing_not_found", "Plan payment listing not found", 404);
      if (listing.status === "enabled") {
        await transaction.query(`UPDATE "plan_payment_listings" SET "status" = 'disabled' WHERE "id" = $1`, [id]);
      }
      return (await transaction.getPlanPaymentListing(id))!;
    });
  }

  async getPlanPurchaseOrder(id: string): Promise<PlanPurchaseOrder | undefined> {
    return this.one<PlanPurchaseOrder>(`SELECT * FROM "plan_purchase_orders" WHERE "id" = $1`, [id]);
  }

  async getPlanPurchaseOrderForUser(id: string, buyerUserId: string): Promise<PlanPurchaseOrder | undefined> {
    return this.one<PlanPurchaseOrder>(`SELECT * FROM "plan_purchase_orders" WHERE "id" = $1 AND "buyer_user_id" = $2`, [id, buyerUserId]);
  }

  async pagePlanPurchaseOrders(
    filter: Parameters<ApplicationOperationPort["pagePlanPurchaseOrders"]>[0] = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pagePlanPurchaseOrders"]>>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("$VALUE", `$${values.length}`));
    };
    if (filter.status) add(`"status" = $VALUE`, filter.status);
    if (filter.buyerUserId) add(`"buyer_user_id" = $VALUE`, filter.buyerUserId);
    if (filter.planId) add(`"plan_id" = $VALUE`, filter.planId);
    if (filter.paymentAsset) add(`"payment_asset" = $VALUE`, normalizeStripeCurrency(filter.paymentAsset));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "plan_purchase_orders" ${where}`, values))?.count ?? 0, "postgres_plan_order_count_invalid");
    const pageSize = normalizeDirectoryPageSize(filter.pageSize);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(filter.page, totalPages);
    const items = await this.rows<PlanPurchaseOrder>(
      `SELECT * FROM "plan_purchase_orders" ${where}
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async createPlanPurchaseOrder(input: Parameters<ApplicationOperationPort["createPlanPurchaseOrder"]>[0]): Promise<PlanPurchaseResult> {
    if (typeof input.useImmediately !== "boolean") throw new RelayError("plan_purchase_use_immediately_required", "useImmediately must be a boolean", 400);
    return this.withRetriedTransaction(async (transaction) => {
      const idempotencyKeyHash = postgresSha256Text(postgresRequiredTrimmed(input.idempotencyKey, "Idempotency-Key"));
      const requestHash = postgresSha256Text(JSON.stringify({ planId: input.planId, useImmediately: input.useImmediately, payment: input.payment }));
      const existing = await transaction.one<PlanPurchaseOrder>(
        `SELECT * FROM "plan_purchase_orders" WHERE "buyer_user_id" = $1 AND "create_idempotency_key_hash" = $2`,
        [input.buyerUserId, idempotencyKeyHash],
      );
      if (existing) {
        if (existing.createRequestHash !== requestHash) throw new RelayError("idempotency_conflict", "Idempotency key was already used with a different request", 409);
        return transaction.planPurchaseResult(existing, true);
      }
      const buyer = await transaction.getUser(input.buyerUserId);
      const plan = await transaction.getPlan(input.planId);
      if (!buyer || buyer.status !== "enabled") throw new RelayError("user_not_found", "Enabled Plan buyer not found", 404);
      if (!plan || plan.catalogStatus !== "listed") throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
      const visible = await transaction.one<{ id: string }>(
        `SELECT "id" FROM "plans" WHERE "id" = $1 AND ("scope_ref" = 'global:' OR "scope_ref" = 'user:' || $2
          OR EXISTS (SELECT 1 FROM "team_memberships" membership INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled' WHERE membership."user_id" = $2 AND "scope_ref" = 'team:' || membership."team_id"))`,
        [plan.id, buyer.id],
      );
      if (!visible) throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
      if (plan.planStatus !== "enabled") throw new RelayError("plan_not_enabled", "Plan is not enabled", 409);
      if (plan.billingMode !== "prepaid") throw new RelayError("plan_card_requires_prepaid", "Plan Cards only support prepaid Plans", 409);
      if (plan.durationSeconds <= 0) throw new RelayError("invalid_plan_duration", "Plan duration must be greater than 0", 409);
      const canonicalPurchaseAmountUnits = creditUnitsFromUsd(plan.purchaseAmount);
      if (canonicalPurchaseAmountUnits <= 0) throw new RelayError("invalid_plan_card_purchase_amount", "Plan Card purchase amount must be positive", 409);
      const now = nowIso();
      if (input.payment.kind === "credit_balance") {
        const account = await transaction.one<CreditAccount>(`SELECT * FROM "credit_accounts" WHERE "scope_ref" = $1 FOR UPDATE`, [userScopeRef(buyer.id)]);
        if (!account || account.status !== "active") throw new RelayError("credit_account_not_found", "Active buyer credit account not found", 404);
        const order = await transaction.insertRow<PlanPurchaseOrder>("plan_purchase_orders", {
          id: createId("plan_purchase_order"), buyerUserId: buyer.id, planId: plan.id, planPaymentListingId: null, paymentChannelId: null,
          paymentKind: "credit_balance", paymentNetwork: "internal", paymentAsset: "USD", expectedPaymentAmountUnits: canonicalPurchaseAmountUnits,
          stripeAmountMinor: null, canonicalPurchaseAmountUnits, useImmediately: input.useImmediately, status: "pending_payment",
          checkoutSessionId: null, paymentIntentId: null, cardId: null, creditLedgerEventId: null, subscriptionId: null, expiresAt: null,
          fulfilledAt: null, paymentFailedAt: null, cancelledAt: null, expiredAt: null, reversedAt: null, reversedByUserId: null, reversalReason: null,
          createIdempotencyKeyHash: idempotencyKeyHash, createRequestHash: requestHash, createdAt: now, updatedAt: now,
        });
        const card = await transaction.createCard({ cardType: "plan", ownerUserId: buyer.id, planId: plan.id, createdAt: now });
        const ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "card_purchase", amountUnits: -canonicalPurchaseAmountUnits, transferId: null, relatedEventId: order.id, planSubscriptionId: null, billingEventId: null, cardId: card.id, fromAccountId: account.id, toAccountId: null, reason: `plan_card:${plan.id}`, actorUserId: buyer.id, createdAt: now });
        await transaction.query(`UPDATE "plan_purchase_orders" SET "status" = 'fulfilled', "card_id" = $2, "credit_ledger_event_id" = $3, "fulfilled_at" = $4, "updated_at" = $4 WHERE "id" = $1`, [order.id, card.id, ledgerEvent.id, now]);
        let subscription: PlanSubscription | null = null;
        if (input.useImmediately) {
          const used = await transaction.useCard({ cardId: card.id, ownerUserId: buyer.id });
          if (used.cardType === "plan") {
            subscription = used.subscription;
            await transaction.query(`UPDATE "plan_purchase_orders" SET "subscription_id" = $2, "updated_at" = $3 WHERE "id" = $1`, [order.id, subscription.id, now]);
          }
        }
        await transaction.audit({ actor: { actorType: "user", actorId: buyer.id }, action: "card.purchase", resource: { resourceType: "card", resourceId: card.id }, result: "success", source: "web", metadata: { orderId: order.id, cardId: card.id, planId: plan.id, paymentKind: "credit_balance", paymentAsset: "USD", expectedPaymentAmountUnits: canonicalPurchaseAmountUnits, canonicalPurchaseAmountUnits, useImmediately: input.useImmediately } });
        return transaction.planPurchaseResult((await transaction.getPlanPurchaseOrder(order.id))!, false);
      }
      const listing = await transaction.getPlanPaymentListing(input.payment.listingId);
      if (!listing || listing.status !== "enabled" || listing.planId !== plan.id) throw new RelayError("plan_payment_listing_not_enabled", "Plan payment listing is not enabled for this Plan", 409);
      const channel = await transaction.getPaymentChannel(listing.paymentChannelId);
      if (!channel || channel.status !== "enabled" || channel.settlementMode !== "stripe_checkout" || channel.paymentNetwork !== "stripe") throw new RelayError("plan_payment_handler_not_supported", "Plan payment handler is unavailable", 409);
      const currency = normalizeStripeCurrency(channel.paymentAsset);
      const stripeAmountMinor = stripeMinorAmountFromUnits(listing.priceAmountUnits, currency);
      const order = await transaction.insertRow<PlanPurchaseOrder>("plan_purchase_orders", {
        id: createId("plan_purchase_order"), buyerUserId: buyer.id, planId: plan.id, planPaymentListingId: listing.id, paymentChannelId: channel.id,
        paymentKind: "payment_listing", paymentNetwork: channel.paymentNetwork, paymentAsset: currency, expectedPaymentAmountUnits: listing.priceAmountUnits,
        stripeAmountMinor, canonicalPurchaseAmountUnits, useImmediately: input.useImmediately, status: "pending_payment", checkoutSessionId: null,
        paymentIntentId: null, cardId: null, creditLedgerEventId: null, subscriptionId: null, expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
        fulfilledAt: null, paymentFailedAt: null, cancelledAt: null, expiredAt: null, reversedAt: null, reversedByUserId: null, reversalReason: null,
        createIdempotencyKeyHash: idempotencyKeyHash, createRequestHash: requestHash, createdAt: now, updatedAt: now,
      });
      await transaction.audit({ actor: { actorType: "user", actorId: buyer.id }, action: "plan_purchase.create", resource: { resourceType: "plan_purchase_order", resourceId: order.id }, result: "success", source: "web", metadata: { orderId: order.id, planId: plan.id, planPaymentListingId: listing.id, paymentChannelId: channel.id, paymentAsset: currency, expectedPaymentAmountUnits: listing.priceAmountUnits, canonicalPurchaseAmountUnits, useImmediately: input.useImmediately } });
      return transaction.planPurchaseResult(order, false);
    });
  }

  async attachStripePlanCheckoutSession(input: { orderId: string; checkoutSessionId: string }): Promise<PlanPurchaseOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.getPlanPurchaseOrder(input.orderId);
      if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
      if (order.paymentKind !== "payment_listing" || order.paymentNetwork !== "stripe") throw new RelayError("stripe_checkout_unavailable", "Order does not use Stripe Checkout", 409);
      const checkoutSessionId = postgresRequiredTrimmed(input.checkoutSessionId, "checkoutSessionId");
      if (order.checkoutSessionId) {
        if (order.checkoutSessionId !== checkoutSessionId) throw new RelayError("stripe_checkout_session_mismatch", "Stripe Checkout Session does not match the order", 409);
        return order;
      }
      if (order.status !== "pending_payment") throw new RelayError("plan_purchase_not_pending_payment", "Plan purchase order is not pending payment", 409);
      return (await transaction.updateRow<PlanPurchaseOrder>("plan_purchase_orders", order.id, { checkoutSessionId, updatedAt: nowIso() }))!;
    });
  }

  async cancelUserPlanPurchaseOrder(input: { orderId: string; buyerUserId: string }): Promise<PlanPurchaseOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.getPlanPurchaseOrderForUser(input.orderId, input.buyerUserId);
      if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
      if (order.status === "cancelled" || order.status === "expired") return order;
      if (order.status !== "pending_payment" || order.paymentKind !== "payment_listing") throw new RelayError("plan_purchase_not_cancelable", "Only pending external Plan purchases can be cancelled", 409);
      const updated = await transaction.updateRow<PlanPurchaseOrder>("plan_purchase_orders", order.id, { status: "cancelled", cancelledAt: nowIso(), updatedAt: nowIso() });
      if (!updated) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
      return updated;
    });
  }

  async reversePlanPurchaseOrder(
    input: Parameters<ApplicationOperationPort["reversePlanPurchaseOrder"]>[0],
  ): Promise<PlanPurchaseResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const order = await transaction.getPlanPurchaseOrder(input.orderId);
      if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
      if (order.paymentKind !== "payment_listing" || order.paymentNetwork !== "stripe") {
        throw new RelayError("plan_purchase_not_reversible", "Only fulfilled Stripe Plan purchases can be reversed", 409);
      }
      if (order.status === "reversed") return transaction.planPurchaseResult(order, true);
      if (order.status !== "fulfilled" || !order.cardId) throw new RelayError("plan_purchase_not_reversible", "Only fulfilled Stripe Plan purchases can be reversed", 409);
      const root = await transaction.getCard(order.cardId);
      if (!root) throw new RelayError("plan_purchase_card_missing", "Plan purchase Card is missing", 500);
      const leaf = await transaction.one<Card>(
        `WITH RECURSIVE chain AS (
           SELECT * FROM "cards" WHERE "id" = $1
           UNION ALL
           SELECT child.* FROM "cards" child INNER JOIN chain parent ON child."replaces_card_id" = parent."id"
         )
         SELECT chain.* FROM chain
         WHERE NOT EXISTS (SELECT 1 FROM "cards" child WHERE child."replaces_card_id" = chain."id")
         LIMIT 1`,
        [root.id],
      );
      if (!leaf) throw new RelayError("plan_purchase_card_missing", "Plan purchase Card replacement leaf is missing", 500);
      const now = nowIso();
      if (leaf.usedAt === null) {
        if (leaf.invalidatedAt === null) {
          await transaction.query(
            `UPDATE "cards" SET "invalidated_at" = $2, "invalidation_reason" = 'plan_purchase_reversed'
             WHERE "id" = $1 AND "used_at" IS NULL AND "invalidated_at" IS NULL`,
            [leaf.id, now],
          );
        }
      } else {
        const subscription = await transaction.one<{ id: string }>(
          `SELECT "id" FROM "plan_subscriptions" WHERE "origin_card_id" = $1 LIMIT 1`,
          [leaf.id],
        );
        if (subscription) {
          const current = await transaction.getPlanSubscription(subscription.id);
          if (current?.subscriptionLifecycle === "active" && (current.effectiveEnd === null || current.effectiveEnd > now)) {
            await transaction.cancelPlanSubscription(current.id, now);
          }
        }
      }
      const reason = postgresRequiredTrimmed(input.reason, "reason", 500);
      await transaction.query(
        `UPDATE "plan_purchase_orders"
         SET "status" = 'reversed', "reversed_at" = $2, "reversed_by_user_id" = $3,
             "reversal_reason" = $4, "updated_at" = $2
         WHERE "id" = $1`,
        [order.id, now, input.ownerUserId, reason],
      );
      await transaction.audit({
        actor: { actorType: "user", actorId: input.ownerUserId },
        action: "plan_purchase.reverse",
        resource: { resourceType: "plan_purchase_order", resourceId: order.id },
        result: "success",
        source: "owner",
        metadata: {
          orderId: order.id,
          planId: order.planId,
          rootCardId: root.id,
          leafCardId: leaf.id,
          paymentAsset: order.paymentAsset,
          expectedPaymentAmountUnits: order.expectedPaymentAmountUnits,
          canonicalPurchaseAmountUnits: order.canonicalPurchaseAmountUnits,
        },
      });
      return transaction.planPurchaseResult((await transaction.getPlanPurchaseOrder(order.id))!, false);
    });
  }

  async recordStripePlanPurchaseTerminal(input: { orderId: string; checkoutSessionId: string; status: "payment_failed" | "expired"; webhookEvent: { eventId: string; eventType: string; livemode: boolean } }): Promise<PlanPurchaseOrder> {
    return this.withRetriedTransaction(async (transaction) => {
      const now = nowIso();
      const priorEvent = await transaction.getStripeWebhookEvent(input.webhookEvent.eventId);
      if (priorEvent && (priorEvent.eventType !== input.webhookEvent.eventType || priorEvent.livemode !== input.webhookEvent.livemode || priorEvent.planPurchaseOrderId !== input.orderId || priorEvent.topupId !== null || priorEvent.checkoutSessionTail !== input.checkoutSessionId.slice(-8) || priorEvent.status === "ignored")) {
        throw new RelayError("stripe_webhook_event_mismatch", "Stripe webhook Event business binding does not match", 409);
      }
      const order = await transaction.getPlanPurchaseOrder(input.orderId);
      if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
      if (!order.checkoutSessionId || order.checkoutSessionId !== input.checkoutSessionId) throw new RelayError("stripe_checkout_session_mismatch", "Stripe Checkout Session does not match the order", 409);
      if (!priorEvent) {
        await transaction.insertRow<StripeWebhookEvent>("stripe_webhook_events", {
          eventId: input.webhookEvent.eventId,
          eventType: input.webhookEvent.eventType,
          livemode: input.webhookEvent.livemode,
          checkoutSessionTail: input.checkoutSessionId.slice(-8),
          topupId: null,
          planPurchaseOrderId: input.orderId,
          status: "received",
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          processedAt: null,
        });
      }
      if (order.status === "pending_payment") {
        await transaction.query(
          `UPDATE "plan_purchase_orders" SET "status" = $2, "${input.status === "payment_failed" ? "payment_failed_at" : "expired_at"}" = $3, "updated_at" = $3 WHERE "id" = $1`,
          [order.id, input.status, now],
        );
      }
      await transaction.query(`UPDATE "stripe_webhook_events" SET "status" = 'succeeded', "error_code" = NULL, "updated_at" = $2, "processed_at" = $2 WHERE "event_id" = $1`, [input.webhookEvent.eventId, now]);
      return (await transaction.getPlanPurchaseOrder(order.id))!;
    });
  }

  async completeStripePlanPurchaseOrder(input: { orderId: string; checkoutSessionId: string; paymentIntentId: string | null; amountMinor: number; currency: string; webhookEvent: { eventId: string; eventType: string; livemode: boolean } }): Promise<PlanPurchaseResult> {
    return this.withRetriedTransaction(async (transaction) => {
      const now = nowIso();
      const priorEvent = await transaction.getStripeWebhookEvent(input.webhookEvent.eventId);
      if (priorEvent && (priorEvent.eventType !== input.webhookEvent.eventType || priorEvent.livemode !== input.webhookEvent.livemode || priorEvent.planPurchaseOrderId !== input.orderId || priorEvent.topupId !== null || priorEvent.checkoutSessionTail !== input.checkoutSessionId.slice(-8) || priorEvent.status === "ignored")) {
        throw new RelayError("stripe_webhook_event_mismatch", "Stripe webhook Event business binding does not match", 409);
      }
      const order = await transaction.getPlanPurchaseOrder(input.orderId);
      if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
      const currency = normalizeStripeCurrency(input.currency);
      const paymentIntentId = input.paymentIntentId ? postgresRequiredTrimmed(input.paymentIntentId, "paymentIntentId") : null;
      if (!paymentIntentId) throw new RelayError("stripe_payment_intent_missing", "Paid Stripe Checkout Session has no PaymentIntent", 409);
      if (order.paymentKind !== "payment_listing" || order.paymentNetwork !== "stripe") throw new RelayError("stripe_checkout_unavailable", "Order does not use Stripe Checkout", 409);
      if (!order.checkoutSessionId || order.checkoutSessionId !== input.checkoutSessionId) throw new RelayError("stripe_checkout_session_mismatch", "Stripe Checkout Session does not match the order", 409);
      if (order.paymentIntentId && order.paymentIntentId !== paymentIntentId) throw new RelayError("stripe_payment_intent_mismatch", "Stripe PaymentIntent does not match the order", 409);
      if (currency !== order.paymentAsset || input.amountMinor !== order.stripeAmountMinor || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RelayError("stripe_checkout_amount_mismatch", "Stripe Checkout amount or currency does not match the order", 409);
      if (priorEvent?.status === "succeeded" || order.status === "fulfilled" || order.status === "reversed") {
        if (priorEvent?.status !== "succeeded") await transaction.query(`UPDATE "stripe_webhook_events" SET "status" = 'succeeded', "error_code" = NULL, "updated_at" = $2, "processed_at" = $2 WHERE "event_id" = $1`, [input.webhookEvent.eventId, now]);
        return transaction.planPurchaseResult(order, true);
      }
      if (!priorEvent) {
        await transaction.insertRow<StripeWebhookEvent>("stripe_webhook_events", {
          eventId: input.webhookEvent.eventId,
          eventType: input.webhookEvent.eventType,
          livemode: input.webhookEvent.livemode,
          checkoutSessionTail: input.checkoutSessionId.slice(-8),
          topupId: null,
          planPurchaseOrderId: input.orderId,
          status: "received",
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          processedAt: null,
        });
      }
      if (order.status !== "pending_payment") throw new RelayError("plan_purchase_not_pending_payment", "Plan purchase order is not pending payment", 409);
      const plan = await transaction.getPlan(order.planId);
      if (!plan || plan.billingMode !== "prepaid" || plan.durationSeconds <= 0) throw new RelayError("plan_purchase_terms_unavailable", "Frozen Plan purchase terms are unavailable", 409);
      const card = await transaction.createCard({ cardType: "plan", ownerUserId: order.buyerUserId, planId: order.planId, createdAt: now });
      await transaction.query(`UPDATE "plan_purchase_orders" SET "status" = 'fulfilled', "payment_intent_id" = $2, "card_id" = $3, "fulfilled_at" = $4, "updated_at" = $4 WHERE "id" = $1`, [order.id, paymentIntentId, card.id, now]);
      let subscription: PlanSubscription | null = null;
      if (order.useImmediately) {
        const used = await transaction.useCard({ cardId: card.id, ownerUserId: order.buyerUserId });
        if (used.cardType === "plan") {
          subscription = used.subscription;
          await transaction.query(`UPDATE "plan_purchase_orders" SET "subscription_id" = $2, "updated_at" = $3 WHERE "id" = $1`, [order.id, subscription.id, now]);
        }
      }
      await transaction.audit({ actor: { actorType: "system", actorId: "stripe" }, action: "plan_purchase.stripe_checkout_complete", resource: { resourceType: "plan_purchase_order", resourceId: order.id }, result: "success", source: "system", requestId: input.webhookEvent.eventId, metadata: { orderId: order.id, cardId: card.id, subscriptionId: subscription?.id ?? null, planId: order.planId, buyerUserId: order.buyerUserId, initiatedBy: order.buyerUserId, paymentAsset: order.paymentAsset, expectedPaymentAmountUnits: order.expectedPaymentAmountUnits, canonicalPurchaseAmountUnits: order.canonicalPurchaseAmountUnits, checkoutSessionTail: input.checkoutSessionId.slice(-8), paymentIntentTail: paymentIntentId.slice(-8) } });
      await transaction.query(`UPDATE "stripe_webhook_events" SET "status" = 'succeeded', "error_code" = NULL, "updated_at" = $2, "processed_at" = $2 WHERE "event_id" = $1`, [input.webhookEvent.eventId, now]);
      return transaction.planPurchaseResult((await transaction.getPlanPurchaseOrder(order.id))!, false);
    });
  }

  private async planPurchaseResult(order: PlanPurchaseOrder, replayed: boolean): Promise<PlanPurchaseResult> {
    return {
      order,
      card: order.cardId ? await this.getCard(order.cardId) ?? null : null,
      ledgerEvent: order.creditLedgerEventId ? await this.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "id" = $1`, [order.creditLedgerEventId]) ?? null : null,
      subscription: order.subscriptionId ? await this.one<PlanSubscription>(`SELECT * FROM "plan_subscriptions" WHERE "id" = $1`, [order.subscriptionId]) ?? null : null,
      replayed,
    };
  }

  async purchasePlanCard(input: { planId: string; buyerUserId: string; useImmediately: boolean }): Promise<{ card: Card; ledgerEvent: CreditLedgerEvent; subscription: PlanSubscription | null }> {
    if (typeof input.useImmediately !== "boolean") throw new RelayError("plan_purchase_use_immediately_required", "useImmediately must be a boolean", 400);
    return this.withRetriedTransaction(async (transaction) => {
      const buyer = await transaction.getUser(input.buyerUserId);
      const plan = await transaction.getPlan(input.planId);
      if (!buyer || buyer.status !== "enabled") throw new RelayError("user_not_found", "Enabled Plan buyer not found", 404);
      if (!plan || plan.catalogStatus !== "listed" || plan.planStatus !== "enabled" || plan.billingMode !== "prepaid" || plan.durationSeconds <= 0) throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
      const visible = await transaction.one<{ id: string }>(
        `SELECT plan."id" FROM "plans" plan
         WHERE plan."id" = $1 AND (plan."scope_ref" = 'global:' OR plan."scope_ref" = 'user:' || $2
           OR EXISTS (SELECT 1 FROM "team_memberships" membership INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled' WHERE membership."user_id" = $2 AND plan."scope_ref" = 'team:' || membership."team_id"))`,
        [plan.id, input.buyerUserId],
      );
      if (!visible) throw new RelayError("plan_not_found", `Plan ${input.planId} not found`, 404);
      const amountUnits = creditUnitsFromUsd(plan.purchaseAmount);
      if (amountUnits <= 0) throw new RelayError("invalid_plan_card_purchase_amount", "Plan Card purchase amount must be positive", 409);
      const account = await transaction.findCreditAccountForScope(userScopeRef(input.buyerUserId));
      if (!account || account.status !== "active") throw new RelayError("credit_account_not_found", "Active buyer credit account not found", 404);
      const now = nowIso();
      const order = await transaction.insertRow<PlanPurchaseOrder>("plan_purchase_orders", {
        id: createId("plan_purchase_order"), buyerUserId: buyer.id, planId: plan.id, planPaymentListingId: null,
        paymentChannelId: null, paymentKind: "credit_balance", paymentNetwork: "internal", paymentAsset: "USD",
        expectedPaymentAmountUnits: amountUnits, stripeAmountMinor: null, canonicalPurchaseAmountUnits: amountUnits,
        useImmediately: input.useImmediately, status: "pending_payment", checkoutSessionId: null, paymentIntentId: null,
        cardId: null, creditLedgerEventId: null, subscriptionId: null, expiresAt: null, fulfilledAt: null,
        paymentFailedAt: null, cancelledAt: null, expiredAt: null, reversedAt: null, reversedByUserId: null,
        reversalReason: null, createIdempotencyKeyHash: postgresSha256Text(createId("legacy_plan_purchase")),
        createRequestHash: postgresSha256Text(JSON.stringify({ planId: plan.id, useImmediately: input.useImmediately, payment: { kind: "credit_balance" } })),
        createdAt: now, updatedAt: now,
      });
      const card = await transaction.createCard({ cardType: "plan", ownerUserId: buyer.id, planId: plan.id, createdAt: now });
      const ledgerEvent = await transaction.createCreditLedgerEvent({ accountId: account.id, eventType: "card_purchase", amountUnits: -amountUnits, transferId: null, relatedEventId: order.id, planSubscriptionId: null, billingEventId: null, cardId: card.id, fromAccountId: account.id, toAccountId: null, reason: `plan_card:${plan.id}`, actorUserId: buyer.id, createdAt: now });
      await transaction.query(`UPDATE "plan_purchase_orders" SET "status" = 'fulfilled', "card_id" = $2, "credit_ledger_event_id" = $3, "fulfilled_at" = $4, "updated_at" = $4 WHERE "id" = $1`, [order.id, card.id, ledgerEvent.id, now]);
      let subscription: PlanSubscription | null = null;
      if (input.useImmediately) {
        const used = await transaction.useCard({ cardId: card.id, ownerUserId: buyer.id });
        if (used.cardType === "plan") {
          subscription = used.subscription;
          await transaction.query(`UPDATE "plan_purchase_orders" SET "subscription_id" = $2, "updated_at" = $3 WHERE "id" = $1`, [order.id, subscription.id, now]);
        }
      }
      await transaction.audit({ actor: { actorType: "user", actorId: buyer.id }, action: "card.purchase", resource: { resourceType: "card", resourceId: card.id }, result: "success", source: "web", metadata: { orderId: order.id, cardId: card.id, planId: plan.id, paymentKind: "credit_balance", paymentAsset: "USD", expectedPaymentAmountUnits: amountUnits, canonicalPurchaseAmountUnits: amountUnits, useImmediately: input.useImmediately } });
      return { card: (await transaction.getCard(card.id))!, ledgerEvent, subscription };
    });
  }

  async getTopupAttachment(
    topupId: string,
    attachmentId: string,
    userId?: string,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getTopupAttachment"]>>> {
    return this.one<Awaited<ReturnType<ApplicationOperationPort["getTopupAttachment"]>>>(
      `SELECT "id", "topup_id" AS "topupId", "storage_key" AS "storageKey",
              "content_type" AS "contentType", "byte_size" AS "byteSize", "sha256",
              "uploaded_by_user_id" AS "uploadedByUserId", "attachment_purpose" AS "attachmentPurpose",
              "created_at" AS "createdAt"
       FROM "credit_topup_attachments"
       WHERE "topup_id" = $1 AND "id" = $2 AND ($3 = '' OR "uploaded_by_user_id" = $3)
       LIMIT 1`,
      [topupId, attachmentId, userId ?? ""],
    );
  }

  async pageTopupAttachments(
    topupId: string,
    input: { userId?: string; purpose?: string; page?: number; pageSize?: number } = {},
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["pageTopupAttachments"]>>> {
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const userId = input.userId ?? "";
    const purpose = input.purpose ?? "";
    const filter = `WHERE "topup_id" = $1 AND ($2 = '' OR "uploaded_by_user_id" = $2) AND ($3 = '' OR "attachment_purpose" = $3)`;
    const totalRow = await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" FROM "credit_topup_attachments" ${filter}`,
      [topupId, userId, purpose],
    );
    const total = safePostgresInteger(totalRow?.count ?? 0, "postgres_topup_attachment_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<Awaited<ReturnType<ApplicationOperationPort["pageTopupAttachments"]>>["items"][number]>(
      `SELECT "id", "topup_id" AS "topupId", "storage_key" AS "storageKey",
              "content_type" AS "contentType", "byte_size" AS "byteSize", "sha256",
              "uploaded_by_user_id" AS "uploadedByUserId", "attachment_purpose" AS "attachmentPurpose",
              "created_at" AS "createdAt"
       FROM "credit_topup_attachments" ${filter}
       ORDER BY "created_at" ASC, "id" ASC
       LIMIT $4 OFFSET $5`,
      [topupId, userId, purpose, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async isCreditTransferOutEnabled(scopeRef: ScopeRef): Promise<boolean> {
    return (await this.getCreditTransferPolicy(scopeRef))?.transferOutEnabled ?? true;
  }

  async usageSummary(input: Parameters<ApplicationOperationPort["usageSummary"]>[0] = {}): Promise<Awaited<ReturnType<ApplicationOperationPort["usageSummary"]>>> {
    const filters: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [["api_key_id", input.apiKeyId], ["user_id", input.userId], ["team_id", input.teamId]] as const) {
      if (value === undefined) continue;
      values.push(value);
      filters.push(`request_identity."${column}" = $${values.length}`);
    }
    const row = await this.one<Awaited<ReturnType<ApplicationOperationPort["usageSummary"]>>>(
      `${POSTGRES_REQUEST_IDENTITY_CTE} SELECT COALESCE(SUM(billing_event."total_tokens"), 0) AS "totalTokens",
              COALESCE(SUM(billing_event."billable_amount"), 0) AS "billableAmount",
              COALESCE(SUM(billing_event."billable_amount"), 0) AS "calculatedCost"
       FROM "billing_history_refs" billing_event
       INNER JOIN request_identity ON request_identity."request_id" = billing_event."request_id"
       ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}`,
      values,
    );
    return {
      totalTokens: Number(row?.totalTokens ?? 0),
      billableAmount: Number(row?.billableAmount ?? 0),
      calculatedCost: Number(row?.calculatedCost ?? 0),
    };
  }

  async pageUsageLogs(page = 1, requestedPageSize?: number): Promise<import("./queries/pagination.js").PageResult<import("./queries/usage.js").UsageLogRow>> {
    const pageSize = normalizeDirectoryPageSize(requestedPageSize);
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "billing_history_refs"`, []))?.count ?? 0, "postgres_usage_log_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const items = await this.rows<import("./queries/pagination.js").PageResult<import("./queries/usage.js").UsageLogRow>["items"][number]>(
      `SELECT "billing_event_id" AS "id", "request_id" AS "requestId", "provider_model_cost_id" AS "modelPriceId",
              "input_tokens" AS "inputTokens", "output_tokens" AS "outputTokens", "total_tokens" AS "totalTokens",
              "billable_amount" AS "calculatedCost", "provider_cost_amount" AS "providerReportedCost",
              "usage_source" AS "usageSource", "occurred_at" AS "createdAt"
       FROM "billing_history_refs"
       ORDER BY "occurred_at" DESC, "billing_event_id" DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  async pageAuditLogs(input: import("./queries/audit-logs.js").AuditLogDirectoryInput = {}): Promise<import("./queries/pagination.js").PageResult<import("./queries/audit-logs.js").AuditLogDirectoryRow>> {
    const source = (input.source ?? "").trim();
    const result = (input.result ?? "").trim();
    const actor = (input.actor ?? "").trim().toLowerCase().slice(0, 100);
    const action = (input.action ?? "").trim().toLowerCase().slice(0, 100);
    const resource = (input.resource ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const filter = `WHERE ($1 = '' OR "source" = $1) AND ($2 = '' OR "result" = $2)
      AND ($3 = '' OR position($3 IN lower("actor_type" || ' ' || "actor_id")) > 0)
      AND ($4 = '' OR position($4 IN lower("action")) > 0)
      AND ($5 = '' OR position($5 IN lower("resource_type" || ':' || "resource_id")) > 0)`;
    const values = [source, result, actor, action, resource];
    const directory = `WITH audit_directory AS (
      SELECT "id","created_at","actor_type","actor_id","source","action","resource_type","resource_id","result" FROM "audit_logs"
      UNION ALL
      SELECT ref."fact_id",ref."occurred_at",ref."actor_type",ref."actor_id",ref."source",ref."action",ref."resource_type",ref."resource_id",ref."result"
      FROM "history_archive_fact_refs" ref
      INNER JOIN "history_archive_closures" closure ON closure."archive_month"=ref."archive_month" AND closure."status" IN ('verified','purged')
      WHERE ref."fact_kind"='audit-log' AND NOT EXISTS (SELECT 1 FROM "audit_logs" hot WHERE hot."id"=ref."fact_id")
    )`;
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `${directory} SELECT COUNT(*)::int AS "count" FROM audit_directory ${filter}`,
      values,
    ))?.count ?? 0, "postgres_audit_log_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<import("./queries/pagination.js").PageResult<import("./queries/audit-logs.js").AuditLogDirectoryRow>["items"][number]>(
      `${directory} SELECT "id", "created_at" AS "createdAt", "actor_type" AS "actorType", "actor_id" AS "actorId",
              "source", "action", "resource_type" AS "resourceType", "resource_id" AS "resourceId", "result"
       FROM audit_directory ${filter}
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT $6 OFFSET $7`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { items, page, pageSize, total, totalPages };
  }

  async ownerProfitSummary(scopeRef: ScopeRef): Promise<Awaited<ReturnType<ApplicationOperationPort["ownerProfitSummary"]>>> {
    const sales = await this.one<{ amount: number }>(
      `WITH facts AS (
         SELECT "id","amount","buyer_scope_ref","seller_scope_ref" FROM "billing_access_point_edges"
         UNION ALL
         SELECT ref."fact_id",ref."amount",ref."buyer_scope_ref",ref."seller_scope_ref"
         FROM "history_archive_fact_refs" ref
         INNER JOIN "history_archive_closures" closure ON closure."archive_month"=ref."archive_month" AND closure."status" IN ('verified','purged')
         WHERE ref."fact_kind"='billing-access-point-edge' AND NOT EXISTS (SELECT 1 FROM "billing_access_point_edges" hot WHERE hot."id"=ref."fact_id")
       ) SELECT COALESCE(SUM("amount"), 0) AS "amount" FROM facts WHERE "seller_scope_ref" = $1`,
      [scopeRef],
    );
    const sourceCost = await this.one<{ amount: number }>(
      `WITH facts AS (
         SELECT "id","amount","buyer_scope_ref","seller_scope_ref" FROM "billing_access_point_edges"
         UNION ALL
         SELECT ref."fact_id",ref."amount",ref."buyer_scope_ref",ref."seller_scope_ref"
         FROM "history_archive_fact_refs" ref
         INNER JOIN "history_archive_closures" closure ON closure."archive_month"=ref."archive_month" AND closure."status" IN ('verified','purged')
         WHERE ref."fact_kind"='billing-access-point-edge' AND NOT EXISTS (SELECT 1 FROM "billing_access_point_edges" hot WHERE hot."id"=ref."fact_id")
       ) SELECT COALESCE(SUM("amount"), 0) AS "amount" FROM facts
       WHERE "buyer_scope_ref" = $1 AND "seller_scope_ref" <> "buyer_scope_ref"`,
      [scopeRef],
    );
    const providerCost = await this.one<{ amount: number }>(
      `WITH facts AS (
         SELECT "id","amount","provider_owner_scope_ref" FROM "billing_provider_cost_events"
         UNION ALL
         SELECT ref."fact_id",ref."amount",ref."provider_owner_scope_ref"
         FROM "history_archive_fact_refs" ref
         INNER JOIN "history_archive_closures" closure ON closure."archive_month"=ref."archive_month" AND closure."status" IN ('verified','purged')
         WHERE ref."fact_kind"='billing-provider-cost-event' AND NOT EXISTS (SELECT 1 FROM "billing_provider_cost_events" hot WHERE hot."id"=ref."fact_id")
       ) SELECT COALESCE(SUM("amount"), 0) AS "amount" FROM facts WHERE "provider_owner_scope_ref" = $1`,
      [scopeRef],
    );
    const salesAmount = Number(sales?.amount ?? 0);
    const sourceCostAmount = Number(sourceCost?.amount ?? 0);
    const providerCostAmount = Number(providerCost?.amount ?? 0);
    return { salesAmount, sourceCostAmount, providerCostAmount, profitAmount: salesAmount - sourceCostAmount - providerCostAmount };
  }

  async usageForSubscription(subscriptionId: string, start: string, end: string): Promise<Awaited<ReturnType<ApplicationOperationPort["usageForSubscription"]>>> {
    const row = await this.one<{ usedTokens: number; usedAmount: number }>(
      `SELECT COALESCE(SUM("total_tokens"), 0)::double precision AS "used_tokens",
              COALESCE(SUM("billable_amount"), 0)::double precision AS "used_amount"
       FROM "billing_history_refs"
       WHERE "billing_subscription_id" = $1 AND "occurred_at" >= $2 AND "occurred_at" <= $3`,
      [subscriptionId, start, end],
    );
    return { usedTokens: Number(row?.usedTokens ?? 0), usedAmount: Number(row?.usedAmount ?? 0) };
  }

  async usageForSubscriptionUser(subscriptionId: string, userId: string, start: string, end: string): Promise<Awaited<ReturnType<ApplicationOperationPort["usageForSubscriptionUser"]>>> {
    const row = await this.one<{ usedTokens: number; usedAmount: number }>(
      `${POSTGRES_REQUEST_IDENTITY_CTE} SELECT COALESCE(SUM(billing."total_tokens"), 0)::double precision AS "used_tokens",
              COALESCE(SUM(billing."billable_amount"), 0)::double precision AS "used_amount"
       FROM "billing_history_refs" billing
       INNER JOIN request_identity request_log ON request_log."request_id" = billing."request_id"
       WHERE billing."billing_subscription_id" = $1 AND request_log."user_id" = $2
         AND billing."occurred_at" >= $3 AND billing."occurred_at" <= $4`,
      [subscriptionId, userId, start, end],
    );
    return { usedTokens: Number(row?.usedTokens ?? 0), usedAmount: Number(row?.usedAmount ?? 0) };
  }

  async usageForScope(scopeRef: ScopeRef, start: string, end: string): Promise<Awaited<ReturnType<ApplicationOperationPort["usageForScope"]>>> {
    const [scopeType, scopeId] = scopeRef.split(":", 2);
    if (!scopeType || (scopeType !== "global" && !scopeId)) throw new RelayError("invalid_scope_ref", "Invalid scope reference", 400);
    const scopeClause = scopeType === "global"
      ? "TRUE"
      : scopeType === "team"
        ? 'request_log."team_id" = $3'
        : scopeType === "user"
          ? 'request_log."user_id" = $3'
          : 'request_log."api_key_id" = $3';
    const values = scopeType === "global" ? [start, end] : [start, end, scopeId];
    const row = await this.one<{ usedTokens: number; usedAmount: number }>(
      `${POSTGRES_REQUEST_IDENTITY_CTE} SELECT COALESCE(SUM(billing."total_tokens"), 0)::double precision AS "used_tokens",
              COALESCE(SUM(billing."billable_amount"), 0)::double precision AS "used_amount"
       FROM "billing_history_refs" billing
       INNER JOIN request_identity request_log ON request_log."request_id" = billing."request_id"
       WHERE ${scopeClause} AND billing."occurred_at" >= $1 AND billing."occurred_at" <= $2`,
      values,
    );
    return { usedTokens: Number(row?.usedTokens ?? 0), usedAmount: Number(row?.usedAmount ?? 0) };
  }

  async latestRequestStartedAtForUser(userId: string): Promise<string | null> {
    const row = await this.one<{ startedAt: string | null }>(
      `SELECT MAX("started_at") AS "startedAt" FROM (SELECT "started_at" FROM "request_logs" WHERE "user_id"=$1 UNION ALL SELECT "started_at" FROM "request_log_archive_entries" WHERE "user_id"=$1) used`,
      [userId],
    );
    return row?.startedAt ?? null;
  }

  async latestRequestStartedAtForApiKey(apiKeyId: string): Promise<string | null> {
    const row = await this.one<{ startedAt: string | null }>(
      `SELECT MAX("started_at") AS "startedAt" FROM (SELECT "started_at" FROM "request_logs" WHERE "api_key_id"=$1 UNION ALL SELECT "started_at" FROM "request_log_archive_entries" WHERE "api_key_id"=$1) used`,
      [apiKeyId],
    );
    return row?.startedAt ?? null;
  }

  async countRequestLogs(filter: RequestLogListFilter = {}): Promise<number> {
    const prepared = postgresRequestLogFilter(filter);
    const row = await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "request_logs"${prepared.sql}`, prepared.values);
    return safePostgresInteger(row?.count ?? 0, "postgres_request_log_count_invalid");
  }

  async listRecentRequestLogs(filter: RequestLogListFilter = {}, limit = 100, offset = 0): Promise<RequestLog[]> {
    const prepared = postgresRequestLogFilter(filter);
    const normalizedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const normalizedOffset = Math.max(0, Math.trunc(offset));
    const limitIndex = prepared.values.length + 1;
    const offsetIndex = prepared.values.length + 2;
    const result = await this.query(
      `SELECT * FROM "request_logs"${prepared.sql}
       ORDER BY "started_at" DESC, "id" DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...prepared.values, normalizedLimit, normalizedOffset],
    );
    return result.rows.map((row) => mapPostgresRow<RequestLog>(row));
  }

  async listRecentRequestLogsForUser(userId: string, filter: Omit<RequestLogListFilter, "userId"> = {}, limit = 100, offset = 0): Promise<RequestLog[]> {
    return this.listRecentRequestLogs({ ...filter, userId }, limit, offset);
  }

  async listRequestLogModels(): Promise<string[]> {
    const rows = await this.rows<{ model: string }>(
      `SELECT "req_model" AS "model" FROM "request_logs" WHERE "req_model" <> ''
       UNION
       SELECT "tar_model" AS "model" FROM "request_logs" WHERE "tar_model" IS NOT NULL AND "tar_model" <> ''
       ORDER BY "model" ASC`,
      [],
    );
    return rows.map((row) => row.model);
  }

  async getRequestLog(id: string): Promise<RequestLog | undefined> {
    return this.one<RequestLog>(`SELECT * FROM "request_logs" WHERE "id" = $1`, [id]);
  }

  async getRequestLogForUser(id: string, userId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getRequestLogForUser"]>>> {
    return this.one<RequestLog>(
      `SELECT * FROM "request_logs" WHERE "id" = $1 AND "user_id" = $2`,
      [id, userId],
    );
  }

  async acquireRequestCaptureDownloadSlot(): Promise<Awaited<ReturnType<ApplicationOperationPort["acquireRequestCaptureDownloadSlot"]>>> {
    const ownerToken = createId("capture_download");
    const result = await this.query(
      `UPDATE "request_capture_download_slots"
       SET "owner_token" = $1, "acquired_at" = $2
       WHERE "slot_id" = (
         SELECT "slot_id" FROM "request_capture_download_slots"
         WHERE "owner_token" IS NULL
         ORDER BY "slot_id" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ) AND "owner_token" IS NULL
       RETURNING "slot_id" AS "slotId", "owner_token" AS "ownerToken", "acquired_at" AS "acquiredAt"`,
      [ownerToken, nowIso()],
    );
    const row = result.rows[0];
    return row ? mapPostgresRow<NonNullable<Awaited<ReturnType<ApplicationOperationPort["acquireRequestCaptureDownloadSlot"]>>>>(row) : null;
  }

  async releaseRequestCaptureDownloadSlot(
    slot: Parameters<ApplicationOperationPort["releaseRequestCaptureDownloadSlot"]>[0],
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["releaseRequestCaptureDownloadSlot"]>>> {
    const result = await this.query(
      `UPDATE "request_capture_download_slots"
       SET "owner_token" = NULL, "acquired_at" = NULL
       WHERE "slot_id" = $1 AND "owner_token" = $2`,
      [slot.slotId, slot.ownerToken],
    );
    return result.rowCount === 1;
  }

  async getVerifiedRequestLogArchiveForMonth(
    archiveMonth: string,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getVerifiedRequestLogArchiveForMonth"]>>> {
    return (await this.one<Awaited<ReturnType<ApplicationOperationPort["getVerifiedRequestLogArchiveForMonth"]>>>(
      `SELECT "archive_month" AS "archiveMonth", "format_version" AS "formatVersion",
              "schema_version" AS "schemaVersion", "status", "row_count" AS "rowCount",
              "compressed_bytes" AS "compressedBytes", "uncompressed_bytes" AS "uncompressedBytes",
              "object_key" AS "objectKey", "object_sha256" AS "objectSha256",
              "manifest_object_key" AS "manifestObjectKey", "manifest_sha256" AS "manifestSha256",
              "created_at" AS "createdAt", "uploaded_at" AS "uploadedAt",
              "verified_at" AS "verifiedAt", "purged_at" AS "purgedAt"
       FROM "request_log_archives"
       WHERE "archive_month" = $1 AND "status" IN ('verified', 'purged')`,
      [archiveMonth],
    )) ?? null;
  }

  async getRequestLogArchiveEntry(requestId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["getRequestLogArchiveEntry"]>>> {
    return (await this.one<Awaited<ReturnType<ApplicationOperationPort["getRequestLogArchiveEntry"]>>>(
      `SELECT entry."request_id" AS "requestId", entry."user_id" AS "userId",
              entry."api_key_id" AS "apiKeyId", entry."team_id" AS "teamId",
              entry."started_at" AS "startedAt", entry."status", entry."req_model" AS "reqModel",
              entry."ingress_hostname" AS "ingressHostname", entry."ingress_route_id" AS "ingressRouteId",
              entry."archive_month" AS "archiveMonth"
       FROM "request_log_archive_entries" entry
       INNER JOIN "request_log_archives" archive ON archive."archive_month" = entry."archive_month"
       WHERE entry."request_id" = $1 AND archive."status" IN ('verified', 'purged')`,
      [requestId],
    )) ?? null;
  }

  async getRequestLogArchiveEntryForUser(
    requestId: string,
    userId: string,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["getRequestLogArchiveEntryForUser"]>>> {
    return (await this.one<Awaited<ReturnType<ApplicationOperationPort["getRequestLogArchiveEntryForUser"]>>>(
      `SELECT entry."request_id" AS "requestId", entry."user_id" AS "userId",
              entry."api_key_id" AS "apiKeyId", entry."team_id" AS "teamId",
              entry."started_at" AS "startedAt", entry."status", entry."req_model" AS "reqModel",
              entry."ingress_hostname" AS "ingressHostname", entry."ingress_route_id" AS "ingressRouteId",
              entry."archive_month" AS "archiveMonth"
       FROM "request_log_archive_entries" entry
       INNER JOIN "request_log_archives" archive ON archive."archive_month" = entry."archive_month"
       WHERE entry."request_id" = $1 AND entry."user_id" = $2
         AND archive."status" IN ('verified', 'purged')`,
      [requestId, userId],
    )) ?? null;
  }

  async listRequestLogArchiveEntries(
    filter: Parameters<ApplicationOperationPort["listRequestLogArchiveEntries"]>[0] = {},
    limit?: number,
  ): Promise<Awaited<ReturnType<ApplicationOperationPort["listRequestLogArchiveEntries"]>>> {
    const clauses = [`archive."status" IN ('verified', 'purged')`];
    const values: unknown[] = [];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (filter.userId) clauses.push(`entry."user_id" = ${add(filter.userId)}`);
    if (filter.teamId) clauses.push(`entry."team_id" = ${add(filter.teamId)}`);
    if (filter.apiKeyId) clauses.push(`entry."api_key_id" = ${add(filter.apiKeyId)}`);
    if (filter.ingressHostname) clauses.push(`entry."ingress_hostname" = ${add(filter.ingressHostname)}`);
    if (filter.status) clauses.push(`entry."status" = ${add(filter.status)}`);
    if (filter.model) clauses.push(`entry."req_model" ILIKE ${add(`%${escapePostgresLike(filter.model)}%`)} ESCAPE '\\'`);
    if (filter.startedAtGte) clauses.push(`entry."started_at" >= ${add(filter.startedAtGte)}`);
    if (filter.startedAtLte) clauses.push(`entry."started_at" <= ${add(filter.startedAtLte)}`);
    if (filter.cursorStartedAt && filter.cursorId) {
      const startedAt = add(filter.cursorStartedAt);
      const cursorId = add(filter.cursorId);
      clauses.push(`(entry."started_at" < ${startedAt} OR (entry."started_at" = ${startedAt} AND entry."request_id" < ${cursorId}))`);
    }
    const limitSql = limit === undefined ? "" : ` LIMIT ${add(Math.max(0, Math.trunc(limit)))}`;
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listRequestLogArchiveEntries"]>>[number]>(
      `SELECT entry."request_id" AS "requestId", entry."user_id" AS "userId",
              entry."api_key_id" AS "apiKeyId", entry."team_id" AS "teamId",
              entry."started_at" AS "startedAt", entry."status", entry."req_model" AS "reqModel",
              entry."ingress_hostname" AS "ingressHostname", entry."ingress_route_id" AS "ingressRouteId",
              entry."archive_month" AS "archiveMonth"
       FROM "request_log_archive_entries" entry
       INNER JOIN "request_log_archives" archive ON archive."archive_month" = entry."archive_month"
       WHERE ${clauses.join(" AND ")}
       ORDER BY entry."started_at" DESC, entry."request_id" DESC${limitSql}`,
      values,
    );
  }

  async createRequestLog(input: Parameters<ApplicationOperationPort["createRequestLog"]>[0]): Promise<RequestLog> {
    const now = input.startedAt ?? nowIso();
    const ingressPluginsJson = input.ingressPluginsJson ?? JSON.stringify(input.ingressPlugins ?? []);
    const pipelinePluginsJson = input.pipelinePluginsJson ?? JSON.stringify(input.pipelineSnapshot ?? { schemaVersion: 1, planRevision: "pending", invocations: [] });
    return this.insertRow<RequestLog>("request_logs", {
      id: input.id,
      apiKeyId: input.apiKeyId,
      userId: input.userId,
      teamId: input.teamId ?? null,
      planId: input.planId ?? null,
      planSubscriptionId: input.planSubscriptionId ?? null,
      entryAccessPointId: input.entryAccessPointId ?? null,
      billingScopeRef: input.billingScopeRef ?? null,
      providerId: input.providerId ?? null,
      requestPath: input.requestPath ?? null,
      ingressHostname: input.ingressHostname ?? null,
      ingressRouteId: input.ingressRouteId ?? null,
      reqModel: input.reqModel,
      tarModel: input.tarModel ?? null,
      ingressPluginsJson,
      pipelinePluginsJson,
      status: input.status,
      errorCode: input.errorCode ?? null,
      credentialFailureReason: input.credentialFailureReason ?? null,
      startedAt: now,
      endedAt: input.endedAt ?? null,
    });
  }

  async acquireRequestExecutionLease(input: Parameters<ApplicationOperationPort["acquireRequestExecutionLease"]>[0]): Promise<RequestExecutionLease> {
    const now = input.now ?? nowIso();
    const leaseUntil = postgresLeaseUntil(now, input.leaseTtlSeconds);
    const row = (await this.query<RequestExecutionLease>(`
      INSERT INTO "request_execution_leases" ("request_id","owner_id","acquired_at","heartbeat_at","lease_until")
      VALUES ($1,$2,$3,$3,$4)
      ON CONFLICT ("request_id") DO UPDATE SET
        "owner_id"=EXCLUDED."owner_id", "acquired_at"=EXCLUDED."acquired_at",
        "heartbeat_at"=EXCLUDED."heartbeat_at", "lease_until"=EXCLUDED."lease_until"
      WHERE "request_execution_leases"."owner_id"=EXCLUDED."owner_id" OR "request_execution_leases"."lease_until"<=$3
      RETURNING *
    `, [input.requestId, input.ownerId, now, leaseUntil])).rows[0];
    if (!row) throw new RelayError("request_execution_lease_conflict", "Request execution is already owned", 409);
    return mapPostgresRow<RequestExecutionLease>(row);
  }

  async renewRequestExecutionLease(input: Parameters<ApplicationOperationPort["renewRequestExecutionLease"]>[0]): Promise<RequestExecutionLease> {
    const now = input.now ?? nowIso();
    const leaseUntil = postgresLeaseUntil(now, input.leaseTtlSeconds);
    const row = (await this.query<RequestExecutionLease>(`UPDATE "request_execution_leases" SET "heartbeat_at"=$3,"lease_until"=$4 WHERE "request_id"=$1 AND "owner_id"=$2 AND "lease_until">$3 RETURNING *`, [input.requestId, input.ownerId, now, leaseUntil])).rows[0];
    if (!row) throw new RelayError("request_execution_lease_lost", "Request execution lease is no longer held", 409);
    return mapPostgresRow<RequestExecutionLease>(row);
  }

  async releaseRequestExecutionLease(input: Parameters<ApplicationOperationPort["releaseRequestExecutionLease"]>[0]): Promise<boolean> {
    return (await this.query(`DELETE FROM "request_execution_leases" WHERE "request_id"=$1 AND "owner_id"=$2`, [input.requestId, input.ownerId])).rowCount === 1;
  }

  async getRequestExecutionLease(requestId: string): Promise<RequestExecutionLease | null> {
    return (await this.one<RequestExecutionLease>(`SELECT * FROM "request_execution_leases" WHERE "request_id"=$1`, [requestId])) ?? null;
  }

  async listRequestProviderAttempts(requestId: string): Promise<Awaited<ReturnType<ApplicationOperationPort["listRequestProviderAttempts"]>>> {
    return this.rows<Awaited<ReturnType<ApplicationOperationPort["listRequestProviderAttempts"]>>[number]>(
      `SELECT * FROM "request_provider_attempts" WHERE "request_id" = $1 ORDER BY "attempt_index" ASC, "id" ASC`,
      [requestId],
    );
  }

  async finalizeRequestPipelineSnapshot(id: string, snapshot: Parameters<ApplicationOperationPort["finalizeRequestPipelineSnapshot"]>[1]): Promise<RequestLog> {
    const current = await this.getRequestLog(id);
    if (!current) throw new RelayError("request_log_not_found", "Request log not found", 404);
    let parsed: { planRevision?: string };
    try {
      parsed = JSON.parse(current.pipelinePluginsJson) as { planRevision?: string };
    } catch {
      throw new RelayError("request_pipeline_snapshot_invalid", "Request pipeline snapshot is invalid", 500);
    }
    if (parsed.planRevision !== "pending") throw new RelayError("request_pipeline_snapshot_already_finalized", "Request pipeline snapshot is already finalized", 409);
    const result = await this.query<RequestLog>(
      `UPDATE "request_logs" SET "pipeline_plugins_json" = $2 WHERE "id" = $1 AND "pipeline_plugins_json" = $3 RETURNING *`,
      [id, JSON.stringify(snapshot), current.pipelinePluginsJson],
    );
    if (!result.rows[0]) throw new RelayError("request_pipeline_snapshot_already_finalized", "Request pipeline snapshot is already finalized", 409);
    return mapPostgresRow<RequestLog>(result.rows[0]);
  }

  async enrichRequestLogResolution(id: string, fields: Parameters<ApplicationOperationPort["enrichRequestLogResolution"]>[1]): Promise<RequestLog> {
    const entries = Object.entries(fields).filter((entry): entry is [keyof typeof fields, string] => entry[1] !== undefined && entry[1] !== null);
    const current = await this.getRequestLog(id);
    if (!current) throw new RelayError("request_log_not_found", "Request log not found", 404);
    if (entries.length === 0) return current;
    for (const [field] of entries) if (current[field] !== null) throw new RelayError("request_log_resolution_already_set", "Request log resolution is already set", 409);
    const allowed = new Set(["teamId", "planId", "planSubscriptionId", "entryAccessPointId", "billingScopeRef", "providerId", "tarModel"]);
    if (entries.some(([field]) => !allowed.has(field))) throw new Error("request_log_resolution_field_invalid");
    const set = entries.map(([field], index) => `"${field.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)}" = $${index + 2}`).join(", ");
    const result = await this.query<RequestLog>(`UPDATE "request_logs" SET ${set} WHERE "id" = $1 RETURNING *`, [id, ...entries.map(([, value]) => value)]);
    if (!result.rows[0]) throw new RelayError("request_log_not_found", "Request log not found", 404);
    return mapPostgresRow<RequestLog>(result.rows[0]);
  }

  async finishRequestLog(id: string, status: string, errorCode?: string | null, failureReason?: ProviderCredentialFailureReason | null): Promise<void> {
    if (failureReason !== undefined && failureReason !== null && (!isProviderCredentialFailureReason(failureReason) || status !== "failed")) {
      throw new RelayError("request_log_credential_failure_reason_invalid", "Request Log credential failure reason is invalid", 400);
    }
    await this.query(
      `UPDATE "request_logs" SET "status" = $2, "error_code" = $3, "credential_failure_reason" = COALESCE($4, "credential_failure_reason"), "ended_at" = $5 WHERE "id" = $1`,
      [id, status, errorCode ?? null, failureReason ?? null, nowIso()],
    );
  }

  async listPlanDefinitions(): Promise<PlanDefinition[]> {
    return this.rows<PlanDefinition>(`SELECT * FROM "plans" ORDER BY "name" ASC, "version" ASC, "id" ASC`);
  }

  async getPlan(id: string): Promise<PlanDefinition | undefined> {
    return this.one<PlanDefinition>(`SELECT * FROM "plans" WHERE "id" = $1`, [id]);
  }

  async isPlanVisibleToUser(plan: PlanDefinition, userId: string): Promise<boolean> {
    if (plan.scopeRef === "global:") return true;
    if (plan.scopeRef === `user:${userId}`) return true;
    if (!plan.scopeRef.startsWith("team:")) return false;
    return Boolean(await this.one(
      `SELECT 1 FROM "team_memberships" membership
       INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
       WHERE membership."team_id" = $1 AND membership."user_id" = $2 LIMIT 1`,
      [plan.scopeRef.slice("team:".length), userId],
    ));
  }

  async createPlanDefinition(input: Parameters<AsyncApplicationOperationPort["createPlanDefinition"]>[0]): Promise<PlanDefinition> {
    const scopeRef = input.scopeRef ?? "global:";
    if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("invalid_scope_ref", `Invalid scope_ref: ${scopeRef}`, 400);
    const template = await this.createPlanTemplate({
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      scopeRef,
      name: input.name,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
      ...(input.billingMode !== undefined ? { billingMode: postgresNormalizePlanBillingMode(input.billingMode) } : {}),
      ...(input.purchaseAmount !== undefined ? { purchaseAmount: input.purchaseAmount } : {}),
      durationSeconds: input.durationSeconds,
      ...(input.planStatus !== undefined ? { status: postgresNormalizePlanStatus(input.planStatus) } : {}),
      ...(input.catalogStatus !== undefined ? { catalogStatus: postgresNormalizePlanCatalogStatus(input.catalogStatus) } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.budgetLimits !== undefined ? { budgetLimits: input.budgetLimits } : {}),
      ...(input.accessPointIds !== undefined ? { accessPointIds: input.accessPointIds } : {}),
      ...(input.accessPointPriceOverrides !== undefined ? { accessPointPriceOverrides: input.accessPointPriceOverrides } : {}),
    });
    return {
      id: template.id,
      ownerId: template.ownerId,
      scopeRef: template.scopeRef,
      name: template.name,
      version: template.version,
      description: template.description,
      adminNote: template.adminNote,
      billingMode: template.billingMode,
      purchaseAmount: template.purchaseAmount,
      durationSeconds: template.durationSeconds,
      planStatus: template.status,
      catalogStatus: template.catalogStatus,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }

  async createPlanTemplate(input: Parameters<ApplicationOperationPort["createPlanTemplate"]>[0]): Promise<PlanTemplate> {
    return this.withRetriedTransaction(async (transaction) => {
      const now = input.createdAt ?? nowIso();
      const name = postgresRequiredTrimmed(input.name, "name");
      const billingMode = postgresNormalizePlanBillingMode(input.billingMode);
      const planStatus = postgresNormalizePlanStatus(input.status);
      const catalogStatus = postgresNormalizePlanCatalogStatus(input.catalogStatus);
      const purchaseAmount = input.purchaseAmount ?? 0;
      const durationSeconds = input.durationSeconds;
      const ownerId = input.ownerId ?? (() => { throw new RelayError("postgres_plan_owner_required", "Plan owner is required", 400); })();
      if (!(await transaction.getUser(ownerId))) throw new RelayError("plan_owner_not_found", "Plan owner not found", 404);
      const version = input.version ?? Number((await transaction.one<{ version: number }>(`SELECT COALESCE(MAX("version"), 0)::int AS "version" FROM "plans" WHERE "name" = $1`, [name]))?.version ?? 0) + 1;
      const plan: PlanDefinition = {
        id: input.id ?? createId("plan"), ownerId, scopeRef: input.scopeRef ?? "global:", name, version,
        description: input.description ?? null, adminNote: input.adminNote ?? null, billingMode, purchaseAmount,
        durationSeconds, planStatus, catalogStatus, createdAt: now, updatedAt: now,
      };
      postgresValidatePlanTerms(plan);
      await transaction.insertRow<PlanDefinition>("plans", plan);
      if (input.budgetLimits !== undefined) await transaction.replacePostgresPlanBudgetLimits(plan.id, input.budgetLimits);
      if (input.accessPointIds !== undefined) await transaction.replacePostgresPlanAccessPoints(plan.id, input.accessPointIds);
      if (input.accessPointPriceOverrides?.length) await transaction.appendPostgresPlanAccessPointPriceOverrides(plan.id, input.accessPointPriceOverrides);
      return postgresPlanTemplate(plan);
    });
  }

  async updatePlanTemplate(id: string, input: Parameters<ApplicationOperationPort["updatePlanTemplate"]>[1]): Promise<PlanTemplate | undefined> {
    return this.withRetriedTransaction(async (transaction) => {
      const existing = await transaction.one<PlanDefinition>(`SELECT * FROM "plans" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!existing) return undefined;
      const nextBillingMode = postgresNormalizePlanBillingMode(input.billingMode ?? existing.billingMode);
      const nextStatus = postgresNormalizePlanStatus(input.status ?? existing.planStatus);
      const nextCatalogStatus = postgresNormalizePlanCatalogStatus(input.catalogStatus ?? existing.catalogStatus);
      const next: PlanDefinition = {
        ...existing,
        ownerId: input.ownerId ?? existing.ownerId,
        scopeRef: input.scopeRef ?? existing.scopeRef,
        name: input.name === undefined ? existing.name : postgresRequiredTrimmed(input.name, "name"),
        version: input.version ?? existing.version,
        description: input.description === undefined ? existing.description : input.description,
        adminNote: input.adminNote === undefined ? existing.adminNote : input.adminNote,
        billingMode: nextBillingMode,
        purchaseAmount: input.purchaseAmount ?? existing.purchaseAmount,
        durationSeconds: input.durationSeconds ?? existing.durationSeconds,
        planStatus: nextStatus,
        catalogStatus: nextCatalogStatus,
        updatedAt: nowIso(),
      };
      postgresValidatePlanTerms(next);
      const currentLimits = await transaction.listPlanBudgetLimitsForPlans([id]);
      const currentAccess = await transaction.rows<{ id: string; accessPointId: string }>(`SELECT "id", "access_point_id" AS "accessPointId" FROM "plan_access_points" WHERE "plan_id" = $1 ORDER BY "access_point_id", "id"`, [id]);
      const nextLimits = input.budgetLimits === undefined ? currentLimits.get(id) ?? [] : normalizePlanBudgetLimits(input.budgetLimits);
      const nextAccessIds = input.accessPointIds === undefined ? currentAccess.map((row) => row.accessPointId) : [...new Set(input.accessPointIds)];
      const limitsChanged = JSON.stringify(nextLimits.map((row) => [row.limitScope, row.metric, row.limitValue, row.windowType, row.windowSeconds])) !== JSON.stringify((currentLimits.get(id) ?? []).map((row) => [row.limitScope, row.metric, row.limitValue, row.windowType, row.windowSeconds]));
      const accessChanged = JSON.stringify([...nextAccessIds].sort()) !== JSON.stringify(currentAccess.map((row) => row.accessPointId).sort());
      const commercialChanged = next.billingMode !== existing.billingMode || next.purchaseAmount !== existing.purchaseAmount || next.durationSeconds !== existing.durationSeconds || limitsChanged || (input.accessPointPriceOverrides?.length ?? 0) > 0;
      const references = await transaction.one<{ referenced: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "plan_subscriptions" WHERE "plan_id" = $1)
          OR EXISTS (SELECT 1 FROM "cards" WHERE "plan_id" = $1)
          OR EXISTS (SELECT 1 FROM "card_activation_batches" WHERE "plan_id" = $1)
          OR EXISTS (SELECT 1 FROM "plan_purchase_orders" WHERE "plan_id" = $1)
          OR EXISTS (SELECT 1 FROM "service_products" WHERE "partner_plan_id" = $1) AS "referenced"`,
        [id],
      );
      if (references?.referenced && commercialChanged) throw new RelayError("sold_plan_terms_immutable", "Sold Plan commercial terms require a new Plan version", 409);
      if (existing.planStatus !== next.planStatus) {
        if (existing.planStatus === "enabled" && next.planStatus === "disabled") throw new RelayError("plan_must_be_closed_first", "Enabled Plan must be closed before it can be disabled", 409);
        if (existing.planStatus === "disabled" && next.planStatus === "closed") throw new RelayError("invalid_plan_status_transition", "Disabled Plan must be enabled before it can be closed", 409);
        if (existing.planStatus === "closed" && next.planStatus === "disabled") {
          const impact = await transaction.getPlanStatusImpact(id);
          if (impact.availableCardCount > 0 || impact.activeOrFutureSubscriptionCount > 0) throw new RelayError("sold_plan_in_use", "Plan with available Cards or active/future Subscriptions cannot be disabled", 409);
        }
      }
      if (next.planStatus !== "enabled") next.catalogStatus = "unlisted";
      postgresValidatePlanTerms(next);
      const updated = await transaction.query<PlanDefinition>(
        `UPDATE "plans" SET "owner_id" = $2, "scope_ref" = $3, "name" = $4, "version" = $5,
         "description" = $6, "admin_note" = $7, "billing_mode" = $8, "purchase_amount" = $9,
         "duration_seconds" = $10, "plan_status" = $11, "catalog_status" = $12, "updated_at" = $13
         WHERE "id" = $1 RETURNING *`,
        [id, next.ownerId, next.scopeRef, next.name, next.version, next.description, next.adminNote, next.billingMode, next.purchaseAmount, next.durationSeconds, next.planStatus, next.catalogStatus, next.updatedAt],
      );
      if (!updated.rows[0]) throw new RelayError("plan_template_not_found", "Plan template not found", 404);
      if (limitsChanged && input.budgetLimits !== undefined) await transaction.replacePostgresPlanBudgetLimits(id, input.budgetLimits);
      if (accessChanged && input.accessPointIds !== undefined) await transaction.replacePostgresPlanAccessPoints(id, input.accessPointIds);
      if (input.accessPointPriceOverrides?.length) await transaction.appendPostgresPlanAccessPointPriceOverrides(id, input.accessPointPriceOverrides);
      return postgresPlanTemplate(mapPostgresRow<PlanDefinition>(updated.rows[0]));
    });
  }

  async deletePlanTemplate(id: string): Promise<boolean> {
    return this.withRetriedTransaction(async (transaction) => {
      await transaction.query(`DELETE FROM "plan_access_points" WHERE "plan_id" = $1`, [id]);
      await transaction.query(`DELETE FROM "plan_budget_limits" WHERE "plan_id" = $1`, [id]);
      const deleted = await transaction.query(`DELETE FROM "plans" WHERE "id" = $1`, [id]);
      return (deleted.rowCount ?? 0) > 0;
    });
  }

  async replaceAvailablePlanCards(input: Parameters<ApplicationOperationPort["replaceAvailablePlanCards"]>[0]): Promise<Awaited<ReturnType<ApplicationOperationPort["replaceAvailablePlanCards"]>>> {
    return this.withRetriedTransaction(async (transaction) => {
      const source = await transaction.one<PlanDefinition>(`SELECT * FROM "plans" WHERE "id" = $1 FOR UPDATE`, [input.sourcePlanId]);
      const target = await transaction.getPlan(input.targetPlanId);
      if (!source) throw new RelayError("source_plan_not_found", "Source Plan not found", 404);
      if (!target) throw new RelayError("target_plan_not_found", "Target Plan not found", 404);
      if (source.id === target.id || source.planStatus !== "closed" || source.billingMode !== "prepaid") throw new RelayError("source_plan_not_replaceable", "Source Plan must be a closed prepaid Plan", 409);
      if (target.planStatus !== "enabled" || target.billingMode !== "prepaid") throw new RelayError("target_plan_not_replaceable", "Target Plan must be an enabled prepaid Plan", 409);
      if (source.name !== target.name || target.version <= source.version || source.ownerId !== target.ownerId || source.scopeRef !== target.scopeRef) throw new RelayError("target_plan_not_compatible", "Target Plan must be a higher version with the same name, owner, and scope", 409);
      const now = nowIso();
      const cards = await transaction.rows<Card>(
        `SELECT * FROM "cards" card WHERE card."plan_id" = $1 AND card."used_at" IS NULL AND card."invalidated_at" IS NULL AND card."expires_at" > $2 AND NOT EXISTS (SELECT 1 FROM "cards" replacement WHERE replacement."replaces_card_id" = card."id") ORDER BY card."created_at", card."id" FOR UPDATE`,
        [source.id, now],
      );
      for (const card of cards) await transaction.createCard({ cardType: "plan", issuanceType: card.issuanceType as CardIssuanceType, ownerUserId: card.ownerUserId, planId: target.id, createdAt: now, expiresAt: card.expiresAt, replacesCardId: card.id });
      const result = { sourcePlanId: source.id, targetPlanId: target.id, replacedCount: cards.length };
      await transaction.audit({ actor: { actorType: "user", actorId: input.ownerUserId }, action: "plan.cards.replace", resource: { resourceType: "plan_template", resourceId: source.id }, result: "success", source: "owner", requestId: input.requestId, metadata: result });
      return result;
    });
  }

  async getPlanRelationSummary(planId: string): Promise<{ accessPointCount: number; budgetLimitCount: number; subscriptionBudgetLimitCount: number; userBudgetLimitCount: number; tokenBudgetLimitCount: number; amountBudgetLimitCount: number }> {
    const row = await this.one<{ accessPointCount: number; budgetLimitCount: number; subscriptionBudgetLimitCount: number; userBudgetLimitCount: number; tokenBudgetLimitCount: number; amountBudgetLimitCount: number }>(
      `SELECT (SELECT COUNT(*)::int FROM "plan_access_points" WHERE "plan_id" = $1) AS "accessPointCount",
       COUNT(*)::int AS "budgetLimitCount",
       COUNT(*) FILTER (WHERE "limit_scope" = 'subscription')::int AS "subscriptionBudgetLimitCount",
       COUNT(*) FILTER (WHERE "limit_scope" = 'user')::int AS "userBudgetLimitCount",
       COUNT(*) FILTER (WHERE "metric" = 'tokens')::int AS "tokenBudgetLimitCount",
       COUNT(*) FILTER (WHERE "metric" = 'amount')::int AS "amountBudgetLimitCount"
       FROM "plan_budget_limits" WHERE "plan_id" = $1`,
      [planId],
    );
    return row ?? { accessPointCount: 0, budgetLimitCount: 0, subscriptionBudgetLimitCount: 0, userBudgetLimitCount: 0, tokenBudgetLimitCount: 0, amountBudgetLimitCount: 0 };
  }

  private async replacePostgresPlanBudgetLimits(planId: string, limits: Parameters<ApplicationOperationPort["createPlanTemplate"]>[0]["budgetLimits"]): Promise<void> {
    await this.query(`DELETE FROM "plan_budget_limits" WHERE "plan_id" = $1`, [planId]);
    for (const limit of normalizePlanBudgetLimits(limits ?? [])) {
      await this.insertRow<PlanBudgetLimit>("plan_budget_limits", { id: createId("plan_limit"), planId, ...limit, createdAt: nowIso() });
    }
  }

  private async replacePostgresPlanAccessPoints(planId: string, accessPointIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(accessPointIds)];
    const accessPoints = await Promise.all(uniqueIds.map((accessPointId) => this.getAccessPoint(accessPointId)));
    if (accessPoints.some((accessPoint) => !accessPoint)) throw new RelayError("access_point_not_found", "AccessPoint not found", 404);
    const enabledModels = new Set<string>();
    for (const accessPoint of accessPoints) {
      if (!accessPoint || accessPoint.status !== "enabled") continue;
      if (enabledModels.has(accessPoint.exposedModel)) throw new RelayError("plan_model_access_point_not_unique", `A Plan can include only one enabled AccessPoint for model ${accessPoint.exposedModel}`, 409);
      enabledModels.add(accessPoint.exposedModel);
    }
    await this.query(`DELETE FROM "plan_access_points" WHERE "plan_id" = $1`, [planId]);
    for (const accessPointId of uniqueIds) await this.insertRow("plan_access_points", { id: createId("plan_ap"), planId, accessPointId, createdAt: nowIso() });
  }

  private async appendPostgresPlanAccessPointPriceOverrides(planId: string, overrides: NonNullable<Parameters<ApplicationOperationPort["createPlanTemplate"]>[0]["accessPointPriceOverrides"]>): Promise<void> {
    for (const override of overrides) await this.createPlanAccessPointPrice({ planId, accessPointId: override.accessPointId, inputPer1M: override.inputPer1M, cachedInputPer1M: override.cachedInputPer1M, outputPer1M: override.outputPer1M, ...(override.cacheWritePer1M !== undefined ? { cacheWritePer1M: override.cacheWritePer1M } : {}) });
  }

  private async validatePostgresAuthorityProductTerms(input: AuthorityProductTerms): Promise<AuthorityProductTerms> {
    const displayName = postgresRequiredTrimmed(input.displayName, "displayName", 120);
    if (input.effectCode !== "team_create_unit" && input.effectCode !== "team_custom_provider_access" && input.effectCode !== "user_custom_provider_access") throw new RelayError("authority_product_effect_invalid", "Unsupported Authority Product effect", 400);
    const bounded = (value: unknown, field: string, min: number, max: number): number => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RelayError("authority_product_value_invalid", `${field} must be an integer between ${min} and ${max}`, 400);
      return parsed;
    };
    const optional = (value: unknown, field: string, max: number): number | null => value === null ? null : bounded(value, field, 1, max);
    const grantUnits = bounded(input.grantUnits, "grantUnits", 1, AUTHORITY_PRODUCT_LIMITS.maxGrantUnits);
    const purchaseAmountUnits = bounded(input.purchaseAmountUnits, "purchaseAmountUnits", 1, AUTHORITY_PRODUCT_LIMITS.maxPurchaseAmountUnits);
    const grantDurationSeconds = bounded(input.grantDurationSeconds, "grantDurationSeconds", 1, AUTHORITY_PRODUCT_LIMITS.maxGrantDurationSeconds);
    const maxLifetimePurchasesPerUser = optional(input.maxLifetimePurchasesPerUser, "maxLifetimePurchasesPerUser", 1_000_000);
    const maxUnconsumedUnitsPerUser = optional(input.maxUnconsumedUnitsPerUser, "maxUnconsumedUnitsPerUser", 1_000_000);
    const maxCurrentOwnedTeams = optional(input.maxCurrentOwnedTeams, "maxCurrentOwnedTeams", AUTHORITY_PRODUCT_LIMITS.maxTeamLimit);
    const maxLifetimeCreatedTeams = optional(input.maxLifetimeCreatedTeams, "maxLifetimeCreatedTeams", AUTHORITY_PRODUCT_LIMITS.maxTeamLimit);
    const settlementHoldSeconds = bounded(input.settlementHoldSeconds, "settlementHoldSeconds", 1, AUTHORITY_PRODUCT_LIMITS.maxSettlementHoldSeconds);
    if (input.refundMode !== "none" && input.refundMode !== "unused_by_owner") throw new RelayError("authority_refund_mode_invalid", "Unsupported Authority Product refund mode", 400);
    const refundDeadlineSeconds = input.refundDeadlineSeconds === null ? null : bounded(input.refundDeadlineSeconds, "refundDeadlineSeconds", 1, AUTHORITY_PRODUCT_LIMITS.maxGrantDurationSeconds);
    if (input.refundMode === "none" && refundDeadlineSeconds !== null) throw new RelayError("authority_refund_terms_invalid", "Non-refundable products cannot define a refund deadline", 400);
    if (input.refundMode === "unused_by_owner" && (refundDeadlineSeconds === null || refundDeadlineSeconds > grantDurationSeconds || refundDeadlineSeconds >= settlementHoldSeconds)) throw new RelayError("authority_refund_terms_invalid", "Refund deadline must not exceed Grant duration and must end before settlement release", 400);
    if (input.effectCode === "team_custom_provider_access" && (grantUnits !== 1 || maxUnconsumedUnitsPerUser !== null || maxCurrentOwnedTeams !== null || maxLifetimeCreatedTeams !== null || input.refundMode !== "none")) throw new RelayError("authority_product_terms_invalid", "Team Provider access requires one non-refundable Team entitlement and no Team creation limits", 400);
    if (input.effectCode === "user_custom_provider_access" && (grantUnits !== 1 || (maxLifetimePurchasesPerUser !== null && maxLifetimePurchasesPerUser < 2) || maxUnconsumedUnitsPerUser !== null || maxCurrentOwnedTeams !== null || maxLifetimeCreatedTeams !== null || input.refundMode !== "none" || refundDeadlineSeconds !== null || grantDurationSeconds % 86_400 !== 0)) throw new RelayError("authority_product_terms_invalid", "Personal Provider access requires one non-refundable slot and a positive integer-day duration", 400);
    if (!isRuntimeScopeRef(input.sellerScopeRef)) throw new RelayError("authority_seller_scope_invalid", "Seller scope is invalid", 400);
    const seller = parseScopeRef(input.sellerScopeRef);
    if (seller.scopeType === "user") {
      const user = await this.getUser(seller.scopeId);
      if (!user || user.status !== "enabled") throw new RelayError("authority_seller_scope_not_found", "Seller scope does not resolve to an economic principal", 404);
    }
    if (seller.scopeType === "team") {
      const team = await this.getTeam(seller.scopeId);
      if (!team || team.status !== "enabled") throw new RelayError("authority_seller_scope_not_found", "Seller scope does not resolve to an economic principal", 404);
    }
    if (seller.scopeType !== "global" && seller.scopeType !== "user" && seller.scopeType !== "team") throw new RelayError("authority_seller_scope_not_found", "Seller scope does not resolve to an economic principal", 404);
    return { displayName, effectCode: input.effectCode, grantUnits, purchaseAmountUnits, grantDurationSeconds, maxLifetimePurchasesPerUser, maxUnconsumedUnitsPerUser, maxCurrentOwnedTeams, maxLifetimeCreatedTeams, refundMode: input.refundMode, refundDeadlineSeconds, settlementHoldSeconds, sellerScopeRef: input.sellerScopeRef };
  }

  private async postgresAuthorityRefundResult(refund: AuthorityRefund): Promise<AuthorityRefundResult> {
    const ledger = await this.one<CreditLedgerEvent>(`SELECT * FROM "credit_ledger_events" WHERE "authority_purchase_id" = $1 AND "event_type" = 'reversal'`, [refund.authorityPurchaseId]);
    const settlement = await this.one<{ id: string }>(`SELECT "id" FROM "seller_settlement_events" WHERE "authority_purchase_id" = $1 AND "event_type" = 'reversal'`, [refund.authorityPurchaseId]);
    if (!ledger || !settlement) throw new RelayError("authority_refund_corrupt", "Authority refund reversal facts are missing", 500);
    return { refund, creditLedgerEventId: ledger.id, sellerSettlementReversalId: settlement.id };
  }

  private async seedDefaultTeamResourcePermissions(teamId: string): Promise<void> {
    await this.withRetriedTransaction(async (transaction) => {
      await transaction.lockTeamMutationScope(teamId);
      const managementActions = [
        "team.read", "team.member.read", "team.member.update", "team.usage.read", "team.billing.read",
        "team.credit.read", "team.provider.create", "team.access_point.create", "team.ap_price.append",
      ] as const;
      const roleActions: Record<string, readonly string[]> = {
        owner: [...managementActions, "team.invite_link.create"],
        viewer: ["team.read", "team.usage.read"],
        billing: ["team.read", "team.member.read", "team.usage.read", "team.billing.read", "team.credit.read"],
        manager: managementActions,
      };
      await transaction.upsertResourcePermissionUnderLock({ resourceType: "team", resourceId: teamId, action: "team.read", subjectType: "team", subjectRef: teamId, status: "enabled" });
      for (const [subjectRole, actions] of Object.entries(roleActions)) {
        for (const action of actions) {
          await transaction.upsertResourcePermissionUnderLock({ resourceType: "team", resourceId: teamId, action, subjectType: "team_role", subjectRef: teamId, subjectRole, status: "enabled" });
        }
      }
      const invitePermission = await transaction.findResourcePermission("team", teamId, "team.invite_link.create", "team", teamId, null);
      if (!invitePermission) {
        await transaction.insertRow<ResourcePermission>("resource_permissions", {
          id: createId("rp"),
          resourceType: "team",
          resourceId: teamId,
          action: "team.invite_link.create",
          subjectType: "team",
          subjectRef: teamId,
          subjectRole: null,
          status: "disabled",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    });
  }

  private async findResourcePermission(
    resourceType: string,
    resourceId: string,
    action: string,
    subjectType: string,
    subjectRef: string,
    subjectRole: string | null,
  ): Promise<ResourcePermission | undefined> {
    return this.one<ResourcePermission>(
      `SELECT * FROM "resource_permissions"
       WHERE "resource_type" = $1 AND "resource_id" = $2 AND "action" = $3
         AND "subject_type" = $4 AND "subject_ref" = $5
         AND "subject_role" IS NOT DISTINCT FROM $6`,
      [resourceType, resourceId, action, subjectType, subjectRef, subjectRole],
    );
  }

  async upsertResourcePermission(input: Parameters<ApplicationOperationPort["upsertResourcePermission"]>[0]): Promise<ResourcePermission> {
    return this.withRetriedTransaction(async (transaction) => {
      if (input.resourceType === "team") await transaction.lockTeamMutationScope(input.resourceId);
      return transaction.upsertResourcePermissionUnderLock(input);
    });
  }

  private async upsertResourcePermissionUnderLock(input: Parameters<ApplicationOperationPort["upsertResourcePermission"]>[0]): Promise<ResourcePermission> {
    const subjectRole = input.subjectRole ?? null;
    const status = input.status ?? "enabled";
    const existing = await this.findResourcePermission(input.resourceType, input.resourceId, input.action, input.subjectType, input.subjectRef, subjectRole);
    if (existing) {
      const result = await this.query<ResourcePermission>(
        `UPDATE "resource_permissions" SET "status" = $2, "updated_at" = $3 WHERE "id" = $1 RETURNING *`,
        [existing.id, status, nowIso()],
      );
      if (!result.rows[0]) throw new Error("postgres_resource_permission_update_empty");
      return mapPostgresRow<ResourcePermission>(result.rows[0]);
    }
    return this.insertRow<ResourcePermission>("resource_permissions", {
      id: createId("rp"),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      action: input.action,
      subjectType: input.subjectType,
      subjectRef: input.subjectRef,
      subjectRole,
      status,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  private async lockTeamMutationScope(teamId: string): Promise<void> {
    await this.query<{ id: string }>(`SELECT "id" FROM "teams" WHERE "id" = $1 FOR UPDATE`, [teamId]);
  }

  private async assertEnabledUserAuthVersion(userId: string, expectedAuthVersion: number): Promise<User> {
    const user = await this.getUser(userId);
    if (!user || user.status !== "enabled" || user.authVersion !== expectedAuthVersion) {
      throw new RelayError("unauthorized", "Invalid or expired authentication state", 401);
    }
    return user;
  }

  private async revokeAllUserCredentials(userId: string, revokedAt: string): Promise<void> {
    void revokedAt;
    await this.query(`DELETE FROM "session" WHERE "user_id" = $1`, [userId]);
  }

  private async listProviderModelCostTiers(providerModelCostId: string): Promise<ProviderModelCostTier[]> {
    return this.rows<ProviderModelCostTier>(
      `SELECT * FROM "provider_model_cost_tiers"
       WHERE "provider_model_cost_id" = $1 ORDER BY "min_input_tokens" ASC, "tier_key" ASC`,
      [providerModelCostId],
    );
  }

  private async postgresEnabledProviderModelCost(
    providerId: string,
    providerModelName: string,
  ): Promise<ProviderModelCost & { tiers: ProviderModelCostTier[] } | undefined> {
    const cost = await this.one<ProviderModelCost>(
      `SELECT * FROM "provider_model_costs"
       WHERE "provider_id" = $1 AND "provider_model_name" = $2 AND "status" = 'enabled'
       ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
      [providerId, providerModelName],
    );
    return cost ? { ...cost, tiers: await this.listProviderModelCostTiers(cost.id) } : undefined;
  }

  private async insertPostgresPriceTiers(
    table: "provider_model_cost_tiers" | "access_point_price_tiers" | "plan_access_point_price_tiers",
    foreignKey: "providerModelCostId" | "accessPointPriceId" | "planAccessPointPriceId",
    parentId: string,
    tiers: Array<PriceTierInput & { tierKey: string; serviceTier: string }>,
    idPrefix: string,
  ): Promise<void> {
    for (const tier of tiers) {
      const now = nowIso();
      await this.insertRow(table, {
        id: createId(idPrefix),
        [foreignKey]: parentId,
        serviceTier: tier.serviceTier,
        tierKey: tier.tierKey,
        minInputTokens: tier.minInputTokens,
        maxInputTokens: tier.maxInputTokens ?? null,
        inputPer1M: tier.inputPer1M,
        cachedInputPer1M: tier.cachedInputPer1M,
        cacheWritePer1M: tier.cacheWritePer1M === undefined ? tier.inputPer1M : tier.cacheWritePer1M,
        outputPer1M: tier.outputPer1M,
        status: tier.status ?? "enabled",
        createdAt: tier.createdAt ?? now,
        updatedAt: tier.updatedAt ?? tier.createdAt ?? now,
      });
    }
  }

  private async assertPostgresAuthorityPurchaseLimits(product: AuthorityProduct, buyerUserId: string, at: string): Promise<void> {
    if (product.maxLifetimePurchasesPerUser !== null) {
      const count = await this.one<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "authority_purchases"
         WHERE "buyer_user_id" = $1 AND "product_code" = $2`,
        [buyerUserId, product.code],
      );
      if (Number(count?.count ?? 0) >= product.maxLifetimePurchasesPerUser) throw new RelayError("authority_purchase_limit_exceeded", "Authority Product lifetime purchase limit reached", 409);
    }
    if (product.maxUnconsumedUnitsPerUser !== null) {
      const row = await this.one<{ units: number }>(
        `SELECT COALESCE(SUM(q."granted_units" - (
                  SELECT COUNT(*) FROM "authority_uses" u WHERE u."grant_quota_id" = q."id"
                )), 0)::int AS "units"
         FROM "authority_grants" g
         INNER JOIN "authority_grant_quotas" q ON q."grant_id" = g."id"
         WHERE g."beneficiary_user_id" = $1 AND g."source_product_code_snapshot" = $2
           AND g."lifecycle" = 'active' AND g."effective_start" <= $3
           AND (g."effective_end" IS NULL OR g."effective_end" > $3)`,
        [buyerUserId, product.code, at],
      );
      if (Number(row?.units ?? 0) + product.grantUnits > product.maxUnconsumedUnitsPerUser) throw new RelayError("authority_unconsumed_limit_exceeded", "Authority Product unconsumed unit limit reached", 409);
    }
  }

  private async assertPostgresPartnerPlanAvailable(partnerPlanId: string): Promise<PlanDefinition> {
    const partnerPlan = await this.getPlan(partnerPlanId);
    if (!partnerPlan) throw new RelayError("plan_not_found", "Partner Plan not found", 404);
    const enabledAccessPoint = await this.one<{ id: string }>(
      `SELECT relation."access_point_id" AS "id"
       FROM "plan_access_points" relation
       INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id"
       WHERE relation."plan_id" = $1 AND access_point."status" = 'enabled'
       LIMIT 1`,
      [partnerPlanId],
    );
    if (partnerPlan.planStatus !== "enabled" || !enabledAccessPoint) {
      throw new RelayError("partner_plan_unavailable", "Partner Plan must be enabled and grant at least one enabled AccessPoint", 409);
    }
    return partnerPlan;
  }

  private async fulfillPostgresServiceOrder(order: ServiceOrder, fulfillmentId: string, ownerUserId: string, at: string): Promise<ServiceFulfillment> {
    if (order.fulfillmentEffect === "partner_team_annual" && order.purchaseIntent === "new") {
      if (!order.durationSeconds || !order.partnerPlanId) throw new RelayError("service_order_snapshot_invalid", "Annual Partner order snapshot is incomplete", 500);
      const allocation = await this.insertRow<PartnerTeamCreationAllocation>("partner_team_creation_allocations", {
        id: createId("partner_allocation"),
        sourceOrderId: order.id,
        ownerUserId: order.buyerUserId,
        partnerPlanId: order.partnerPlanId,
        durationSeconds: order.durationSeconds,
        consumedTeamId: null,
        consumedAt: null,
        createdAt: at,
      });
      return this.completePostgresServiceFulfillment(fulfillmentId, { targetType: "partner_team_creation_allocation", targetId: allocation.id, completedByUserId: ownerUserId, at });
    }
    if (order.fulfillmentEffect === "partner_team_annual" && order.purchaseIntent === "renew") {
      if (!order.targetPartnerTeamId || !order.durationSeconds || !order.partnerPlanId) throw new RelayError("service_order_snapshot_invalid", "Partner renewal order snapshot is incomplete", 500);
      const team = await this.getTeam(order.targetPartnerTeamId);
      if (!team || team.status !== "enabled" || team.ownerId !== order.buyerUserId) throw new RelayError("partner_team_not_found", "Renewal target is not an enabled Team owned by the buyer", 404);
      const existingState = await this.getPartnerOperatingState(order.targetPartnerTeamId, at);
      if (existingState.kind === "not_partner") throw new RelayError("partner_team_not_found", "Renewal target is not a Partner Team", 409);
      const latestEnd = await this.latestPostgresPartnerEntitlementEnd(order.targetPartnerTeamId, at);
      const effectiveStart = latestEnd && latestEnd > at ? latestEnd : at;
      const entitlement = await this.createPostgresPartnerEntitlement({
        sourceOrderId: order.id,
        ownerUserId: order.buyerUserId,
        partnerTeamId: order.targetPartnerTeamId,
        partnerPlanId: order.partnerPlanId,
        durationSeconds: order.durationSeconds,
        effectiveStart,
      });
      return this.completePostgresServiceFulfillment(fulfillmentId, { targetType: "partner_operating_entitlement", targetId: entitlement.id, completedByUserId: ownerUserId, at });
    }
    throw new RelayError("service_order_snapshot_invalid", "Annual Partner order purchase intent is invalid", 500);
  }

  private async completePostgresServiceFulfillment(id: string, input: { targetType: string; targetId: string; completedByUserId: string; at: string }): Promise<ServiceFulfillment> {
    const updated = await this.query<ServiceFulfillment>(
      `UPDATE "service_fulfillments"
       SET "target_type" = $2, "target_id" = $3, "status" = 'fulfilled',
           "completed_by_user_id" = $4, "completed_at" = $5, "updated_at" = $5
       WHERE "id" = $1 RETURNING *`,
      [id, input.targetType, input.targetId, input.completedByUserId, input.at],
    );
    if (!updated.rows[0]) throw new RelayError("service_fulfillment_not_found", "Service fulfillment not found", 404);
    await this.query(`UPDATE "service_orders" SET "status" = 'fulfilled', "updated_at" = $2 WHERE "id" = (SELECT "order_id" FROM "service_fulfillments" WHERE "id" = $1)`, [id, input.at]);
    return mapPostgresRow<ServiceFulfillment>(updated.rows[0]);
  }

  private async createPostgresPartnerEntitlement(input: { sourceOrderId: string; ownerUserId: string; partnerTeamId: string; partnerPlanId: string; durationSeconds: number; effectiveStart: string }): Promise<PartnerOperatingEntitlement> {
    const effectiveEnd = postgresAddSeconds(input.effectiveStart, input.durationSeconds);
    const subscription = await this.createPlanSubscription({
      planId: input.partnerPlanId,
      scopeRef: teamScopeRef(input.partnerTeamId),
      purchasedByUserId: input.ownerUserId,
      source: "partner_annual",
      priority: 10,
      effectiveStart: input.effectiveStart,
      effectiveEnd,
    });
    return this.insertRow<PartnerOperatingEntitlement>("partner_operating_entitlements", {
      id: createId("partner_entitlement"),
      sourceOrderId: input.sourceOrderId,
      ownerUserId: input.ownerUserId,
      partnerTeamId: input.partnerTeamId,
      partnerPlanId: input.partnerPlanId,
      planSubscriptionId: subscription.id,
      effectiveStart: input.effectiveStart,
      effectiveEnd,
      lifecycle: "active",
      createdAt: nowIso(),
    });
  }

  private async latestPostgresPartnerEntitlementEnd(partnerTeamId: string, at: string): Promise<string | null> {
    const row = await this.one<{ effectiveEnd: string | null }>(
      `SELECT MAX(
                CASE
                  WHEN subscription."effective_end" IS NULL OR entitlement."effective_end" < subscription."effective_end" THEN entitlement."effective_end"
                  ELSE subscription."effective_end"
                END
              ) AS "effectiveEnd"
       FROM "partner_operating_entitlements" entitlement
       INNER JOIN "plan_subscriptions" subscription
         ON subscription."id" = entitlement."plan_subscription_id"
       WHERE entitlement."partner_team_id" = $1
         AND entitlement."lifecycle" = 'active'
         AND subscription."subscription_lifecycle" = 'active'
         AND entitlement."effective_end" > $2
         AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)`,
      [partnerTeamId, at],
    );
    return row?.effectiveEnd ?? null;
  }

  private async insertPostgresAuthorityPurchase(input: {
    product: AuthorityProduct;
    buyerUserId: string;
    creditAccountId: string;
    idempotencyKeyHash: string;
    requestHash: string;
    createdAt: string;
  }): Promise<AuthorityPurchase> {
    const { product } = input;
    return this.insertRow<AuthorityPurchase>("authority_purchases", {
      id: createId("authority_purchase"), productId: product.id, buyerUserId: input.buyerUserId, creditAccountId: input.creditAccountId,
      productCode: product.code, productVersion: product.version, productDisplayName: product.displayName,
      effectCode: product.effectCode, grantUnits: product.grantUnits, purchaseAmountUnits: product.purchaseAmountUnits,
      grantDurationSeconds: product.grantDurationSeconds, maxLifetimePurchasesPerUser: product.maxLifetimePurchasesPerUser,
      maxUnconsumedUnitsPerUser: product.maxUnconsumedUnitsPerUser, maxCurrentOwnedTeams: product.maxCurrentOwnedTeams,
      maxLifetimeCreatedTeams: product.maxLifetimeCreatedTeams, refundMode: product.refundMode,
      refundDeadlineSeconds: product.refundDeadlineSeconds, settlementHoldSeconds: product.settlementHoldSeconds,
      sellerScopeRef: product.sellerScopeRef, idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash, createdAt: input.createdAt,
    });
  }

  private async listAccessPointPriceTiers(accessPointPriceId: string): Promise<AccessPointPriceTier[]> {
    return this.rows<AccessPointPriceTier>(
      `SELECT * FROM "access_point_price_tiers"
       WHERE "access_point_price_id" = $1 ORDER BY "min_input_tokens" ASC, "tier_key" ASC`,
      [accessPointPriceId],
    );
  }

  private async postgresEnabledAccessPointPrice(
    accessPointId: string,
  ): Promise<AccessPointPrice & { tiers: AccessPointPriceTier[] } | undefined> {
    const price = await this.one<AccessPointPrice>(
      `SELECT * FROM "access_point_prices"
       WHERE "access_point_id" = $1 AND "status" = 'enabled'
       ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
      [accessPointId],
    );
    return price ? { ...price, tiers: await this.listAccessPointPriceTiers(price.id) } : undefined;
  }

  private async listPlanAccessPointPriceTiers(planAccessPointPriceId: string): Promise<PlanAccessPointPriceTier[]> {
    return this.rows<PlanAccessPointPriceTier>(
      `SELECT * FROM "plan_access_point_price_tiers"
       WHERE "plan_access_point_price_id" = $1 ORDER BY "min_input_tokens" ASC, "tier_key" ASC`,
      [planAccessPointPriceId],
    );
  }

  private async pageSimpleTable<T>(
    table: string,
    input: { page?: number; pageSize?: number; query?: string; status?: string },
    searchColumns: readonly string[],
    selectSql: string,
    orderSql: string,
  ): Promise<{ items: T[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const query = (input.query ?? "").trim().toLowerCase().slice(0, 100);
    const pageSize = normalizeDirectoryPageSize(input.pageSize);
    const search = searchColumns.length === 0 ? "$1 = ''" : `($1 = '' OR ${searchColumns.map((column) => `position($1 IN lower("${column}")) > 0`).join(" OR ")})`;
    const status = input.status && input.status !== "all" ? input.status : null;
    const filter = `${search} AND ($2::text IS NULL OR "status" = $2)`;
    const total = safePostgresInteger((await this.one<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "${table}" WHERE ${filter}`, [query, status]))?.count ?? 0, "postgres_directory_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = normalizeDirectoryPage(input.page, totalPages);
    const items = await this.rows<T>(`${selectSql} FROM "${table}" WHERE ${filter} ${orderSql} LIMIT $3 OFFSET $4`, [query, status, pageSize, (page - 1) * pageSize]);
    return { items, page, pageSize, total, totalPages };
  }

  private async pageSimplePostgresCandidates<T>(
    fromSql: string,
    selectSql: string,
    searchColumns: readonly string[],
    query: string,
    page: number,
    orderSql: string,
    prefixValues: readonly unknown[] = [],
  ): Promise<{ items: T[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const normalized = query.trim().toLowerCase().slice(0, 100);
    const pageSize = 20;
    const queryParam = prefixValues.length + 1;
    const search = searchColumns.length === 0
      ? `$${queryParam} = ''`
      : `($${queryParam} = '' OR ${searchColumns.map((column) => `position($${queryParam} IN lower(${column})) > 0`).join(" OR ")})`;
    const filteredFrom = `${fromSql} AND ${search}`;
    const total = safePostgresInteger((await this.one<{ count: number }>(
      `SELECT COUNT(*)::int AS "count" ${filteredFrom}`,
      [...prefixValues, normalized],
    ))?.count ?? 0, "postgres_candidate_count_invalid");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = normalizeDirectoryPage(page, totalPages);
    const limitParam = queryParam + 1;
    const offsetParam = queryParam + 2;
    const items = await this.rows<T>(
      `${selectSql} ${filteredFrom} ${orderSql} LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...prefixValues, normalized, pageSize, (normalizedPage - 1) * pageSize],
    );
    return { items, page: normalizedPage, pageSize, total, totalPages };
  }

  private async rows<T>(text: string, values: readonly unknown[] = []): Promise<T[]> {
    const result = await this.query(text, values);
    return result.rows.map((row) => mapPostgresRow<T>(row));
  }

  private async one<T>(text: string, values: readonly unknown[]): Promise<T | undefined> {
    const result = await this.query(text, values);
    const row = result.rows[0];
    return row ? mapPostgresRow<T>(row) : undefined;
  }

  private async insertRow<T extends QueryResultRow>(table: string, row: object): Promise<T> {
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    const columns = entries.map(([key]) => quoteIdentifier(camelToSnake(key)));
    const placeholders = entries.map(([,], index) => `$${index + 1}`);
    const result = await this.query<T>(
      `INSERT INTO ${quoteIdentifier(table)} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      entries.map(([key, value]) => postgresParameterValue(key, value)),
    );
    const rowResult = result.rows[0];
    if (!rowResult) throw new Error("postgres_insert_returning_empty");
    return mapPostgresRow<T>(rowResult);
  }

  private async upsertBetterAuthIdentity(input: { id: string; email: string; passwordHash: string; createdAt: string; updatedAt: string }): Promise<void> {
    await this.query(
      `INSERT INTO "user" ("id", "name", "email", "email_verified", "image", "created_at", "updated_at")
       VALUES ($1, $2, $3, false, NULL, $4, $5)
       ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "updated_at" = EXCLUDED."updated_at"`,
      [input.id, `Friday User ${input.id}`, input.email, input.createdAt, input.updatedAt],
    );
    await this.query(
      `INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "issuer", "password", "created_at", "updated_at")
       VALUES ($1, $2, 'credential', $2, 'local:credential', $3, $4, $5)
       ON CONFLICT ("issuer", "account_id") DO UPDATE SET "password" = EXCLUDED."password", "updated_at" = EXCLUDED."updated_at"`,
      [`auth_account_${input.id}`, input.id, input.passwordHash, input.createdAt, input.updatedAt],
    );
  }

  private async upsertRow<T extends QueryResultRow>(table: string, row: object, conflictKeys: readonly string[], updateKeys: readonly string[]): Promise<T> {
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    const columns = entries.map(([key]) => quoteIdentifier(camelToSnake(key)));
    const placeholders = entries.map(([,], index) => `$${index + 1}`);
    const updates = updateKeys.map((key) => `${quoteIdentifier(camelToSnake(key))} = EXCLUDED.${quoteIdentifier(camelToSnake(key))}`);
    const conflict = conflictKeys.map((key) => quoteIdentifier(camelToSnake(key))).join(", ");
    const result = await this.query<T>(
      `INSERT INTO ${quoteIdentifier(table)} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (${conflict}) DO ${updates.length > 0 ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"} RETURNING *`,
      entries.map(([key, value]) => postgresParameterValue(key, value)),
    );
    if (result.rows[0]) return mapPostgresRow<T>(result.rows[0]);
    const where = conflictKeys.map((key, index) => `${quoteIdentifier(camelToSnake(key))} = $${index + 1}`).join(" AND ");
    const selected = await this.one<T>(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`, conflictKeys.map((key) => (row as Record<string, unknown>)[key]));
    if (!selected) throw new Error("postgres_upsert_readback_empty");
    return selected;
  }

  private async providerBindingRow(input: Parameters<ApplicationOperationPort["upsertProviderBinding"]>[0]): Promise<ProviderBinding> {
    const existing = await this.getProviderBinding(input.providerId);
    const now = nowIso();
    return {
      providerId: input.providerId,
      authMethod: input.authMethod,
      credentialOwnership: input.credentialOwnership,
      credentialRefsJson: input.credentialRefsJson ?? existing?.credentialRefsJson ?? "[]",
      credentialPreview: input.credentialPreview === undefined ? existing?.credentialPreview ?? null : input.credentialPreview,
      revision: input.revision ?? existing?.revision ?? 1,
      syncStatus: input.syncStatus,
      errorCode: input.syncStatus === "error" ? input.errorCode ?? "cliproxy_binding_error" : null,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private async updateRow<T extends QueryResultRow>(table: string, id: string, patch: object): Promise<T | undefined> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.one<T>(`SELECT * FROM ${quoteIdentifier(table)} WHERE "id" = $1`, [id]);
    const set = entries.map(([key], index) => `${quoteIdentifier(camelToSnake(key))} = $${index + 1}`).join(", ");
    const result = await this.query<T>(
      `UPDATE ${quoteIdentifier(table)} SET ${set} WHERE "id" = $${entries.length + 1} RETURNING *`,
      [...entries.map(([key, value]) => postgresParameterValue(key, value)), id],
    );
    const row = result.rows[0];
    return row ? mapPostgresRow<T>(row) : undefined;
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.transactionContext
      ? this.transactionContext.query<T>(text, values)
      : this.client.query<T>(text, values);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

const POSTGRES_SELLER_SETTLEMENT_WINDOW_MS = 2_592_000 * 1000;

type PostgresCreditCursorKind = "topup" | "ledger";
type PostgresCreditCursor = { kind: PostgresCreditCursorKind; createdAt: string; id: string };

function postgresCardStatusReasonCode(status: string): "card_replaced" | "card_invalidated" | "card_used" | "card_expired" {
  if (status === "replaced") return "card_replaced";
  if (status === "invalidated") return "card_invalidated";
  if (status === "used") return "card_used";
  if (status === "expired") return "card_expired";
  throw new Error("postgres_unavailable_card_missing_reason");
}

function encodePostgresCreditCursor(cursor: PostgresCreditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePostgresCreditCursor(value: string | undefined, kind: PostgresCreditCursorKind): PostgresCreditCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PostgresCreditCursor>;
    if (decoded.kind !== kind || typeof decoded.createdAt !== "string" || !Number.isFinite(Date.parse(decoded.createdAt))
      || typeof decoded.id !== "string" || decoded.id.length === 0 || decoded.id.length > 200) {
      throw new CreditCursorError("Invalid Credit cursor");
    }
    return { kind, createdAt: decoded.createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof CreditCursorError) throw error;
    throw new CreditCursorError("Invalid Credit cursor");
  }
}

function postgresCreditCursorPage<T extends { id: string; createdAt: string }>(rows: T[], kind: PostgresCreditCursorKind, pageSize: number) {
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  const last = hasMore ? items.at(-1) : undefined;
  return {
    items,
    pageSize,
    hasMore,
    nextCursor: last ? encodePostgresCreditCursor({ kind, createdAt: last.createdAt, id: last.id }) : null,
  };
}

function postgresTeamUsageCtes(): string {
  return `
    WITH request_identity AS (${POSTGRES_REQUEST_IDENTITY_SOURCE}), usage_by_user AS (
      SELECT request_log."user_id" AS "userId",
             COUNT(DISTINCT billing_event."request_id")::int AS "requestCount",
             COALESCE(SUM(billing_event."total_tokens"), 0) AS "totalTokens",
             COALESCE(SUM(billing_event."billable_amount"), 0) AS "billableAmount",
             MAX(billing_event."occurred_at") AS "lastUsedAt"
      FROM "billing_history_refs" billing_event
      INNER JOIN request_identity request_log ON request_log."request_id" = billing_event."request_id"
      WHERE billing_event."billing_subscription_id" = $1
        AND billing_event."occurred_at" >= $2
        AND billing_event."occurred_at" < $3
      GROUP BY request_log."user_id"
    ),
    current_members AS (
      SELECT membership."user_id" AS "userId", membership."roles_json" AS "rolesJson",
             identity."email", user_row."status"
      FROM "team_memberships" membership
      INNER JOIN "user_controls" user_row ON user_row."id" = membership."user_id"
      INNER JOIN "user" identity ON identity."id" = user_row."id"
      WHERE membership."team_id" = $4
    )`;
}

function postgresTeamMemberUsageOrder(sort: string, direction: string): string {
  const sqlDirection = direction === "asc" ? "ASC" : "DESC";
  if (sort === "member") return `lower(member."email") ${sqlDirection}, member."userId" ASC`;
  if (sort === "tokens") return `COALESCE(usage."totalTokens", 0) ${sqlDirection}, member."userId" ASC`;
  if (sort === "requests") return `COALESCE(usage."requestCount", 0) ${sqlDirection}, member."userId" ASC`;
  if (sort === "lastUsed") return `usage."lastUsedAt" IS NULL ASC, usage."lastUsedAt" ${sqlDirection}, member."userId" ASC`;
  return `COALESCE(usage."billableAmount", 0) ${sqlDirection}, member."userId" ASC`;
}

function postgresSafeRoles(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((role): role is string => typeof role === "string") : [];
  } catch {
    return [];
  }
}

function postgresProviderDirectoryCte(): string {
  return `WITH directory AS (
    SELECT provider."id", provider."owner_id" AS "ownerId", provider."scope_ref" AS "scopeRef",
           provider."name", provider."kind", provider."status",
           provider."base_url_resolver" AS "baseUrlResolver",
           provider."credential_resolver" AS "credentialResolver",
           provider."models_resolver" AS "modelsResolver",
           provider."config_json" AS "configJson",
           provider."created_at" AS "createdAt", provider."updated_at" AS "updatedAt",
           binding."auth_method" AS "authMethod",
           binding."credential_ownership" AS "credentialOwnership",
           binding."credential_preview" AS "credentialPreview",
           binding."revision", binding."sync_status" AS "syncStatus",
           binding."error_code" AS "errorCode",
           binding."updated_at" AS "bindingUpdatedAt",
           (SELECT COUNT(*)::int FROM "provider_models" model WHERE model."provider_id" = provider."id") AS "modelCount",
           ARRAY(
             SELECT model."provider_model_name"
             FROM "provider_models" model
             WHERE model."provider_id" = provider."id"
             ORDER BY model."provider_model_name" ASC, model."id" ASC
             LIMIT 3
           ) AS "modelNames",
           EXISTS(
             SELECT 1 FROM "access_points" access_point
             WHERE access_point."target_type" = 'provider-model'
               AND access_point."target_provider_id" = provider."id"
           ) AS "hasAccessPointReferences",
           EXISTS(
             SELECT 1 FROM "billing_provider_cost_events" cost_event
             WHERE cost_event."provider_id" = provider."id"
           ) AS "hasOnlineBillingHistory",
           (
             NOT EXISTS(
               SELECT 1 FROM "provider_bindings" credential_binding
               WHERE credential_binding."provider_id" = provider."id"
             )
             OR EXISTS(
               SELECT 1 FROM "provider_bindings" credential_binding
               WHERE credential_binding."provider_id" = provider."id"
                 AND friday_relay_json_type(credential_binding."credential_refs_json") = 'array'
                 AND jsonb_array_length(credential_binding."credential_refs_json"::jsonb) = 0
                 AND credential_binding."credential_preview" IS NULL
                 AND credential_binding."error_code" IS NULL
                 AND credential_binding."sync_status" = 'cleared'
             )
           ) AS "credentialCleared"
    FROM "providers" provider
    LEFT JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
    WHERE $1 OR NOT(
      provider."status" = 'disabled'
      AND EXISTS(
        SELECT 1 FROM "billing_provider_cost_events" cost_event
        WHERE cost_event."provider_id" = provider."id"
      )
    )
  )`;
}

function postgresBudgetUsageWindow(
  key: string,
  policy: Pick<PlanBudgetLimit, "metric" | "windowType" | "windowSeconds">,
  subscription: Pick<PlanSubscription, "effectiveStart" | "effectiveEnd">,
  at: string,
) {
  const window = planBudgetWindow(policy, subscription, at);
  return {
    key,
    metric: policy.metric,
    windowType: policy.windowType,
    windowSeconds: policy.windowSeconds,
    ...window,
    endExclusive: true as const,
  };
}

function postgresPlanSubscriptionUsageContext(subscription: PlanSubscription, at: string): {
  subscription: PlanSubscription;
  effectiveState: PlanSubscriptionEffectiveState;
  usageMode: PlanSubscriptionUsageMode;
  usageReferenceAt: string | null;
} {
  const startsInFuture = subscription.effectiveStart > at;
  const endedAt = subscription.effectiveEnd && subscription.effectiveEnd <= at ? subscription.effectiveEnd : null;
  const neverStarted = Boolean(subscription.effectiveEnd && subscription.effectiveEnd <= subscription.effectiveStart);
  const isCurrent = subscription.subscriptionLifecycle === "active"
    && !startsInFuture
    && (subscription.effectiveEnd === null || subscription.effectiveEnd > at);
  if (isCurrent) return { subscription, effectiveState: "current", usageMode: "current", usageReferenceAt: at };
  if (startsInFuture && subscription.subscriptionLifecycle === "active") {
    return { subscription, effectiveState: "future", usageMode: "not_started", usageReferenceAt: null };
  }
  return {
    subscription,
    effectiveState: "ended",
    usageMode: neverStarted || startsInFuture ? "not_started" : "at_end",
    usageReferenceAt: neverStarted || startsInFuture ? null : endedAt ?? at,
  };
}

function postgresPlanBillingMode(mode: string | null | undefined): PlanBillingMode {
  const value = String(mode ?? "prepaid").trim().toLowerCase();
  if (value === "prepaid" || value === "included") return "prepaid";
  if (value === "paygo" || value === "pay_as_you_go" || value === "pay-as-you-go") return "paygo";
  throw new RelayError("invalid_plan_billing_mode", "Plan billing mode must be prepaid or paygo", 400);
}

interface PostgresBudgetEventRow {
  subscriptionId: string;
  userId: string;
  createdAt: string;
  totalTokens: number;
  billableAmount: number;
}

function sellerSettlementWindowFor(subscription: { effectiveStart: string }, at: string): { windowStart: string; windowEnd: string; releaseAt: string } {
  const subscriptionStartMs = Date.parse(subscription.effectiveStart);
  const atMs = Date.parse(at);
  if (!Number.isFinite(subscriptionStartMs) || !Number.isFinite(atMs)) throw new RelayError("invalid_seller_settlement_window", "Seller settlement timestamps are invalid", 500);
  const windowIndex = Math.max(0, Math.floor((atMs - subscriptionStartMs) / POSTGRES_SELLER_SETTLEMENT_WINDOW_MS));
  const windowStartMs = subscriptionStartMs + windowIndex * POSTGRES_SELLER_SETTLEMENT_WINDOW_MS;
  const windowEndMs = windowStartMs + POSTGRES_SELLER_SETTLEMENT_WINDOW_MS;
  return { windowStart: new Date(windowStartMs).toISOString(), windowEnd: new Date(windowEndMs).toISOString(), releaseAt: new Date(windowEndMs).toISOString() };
}

export function prepaidSellerSettlementTranches(
  subscription: Pick<PlanSubscription, "effectiveStart" | "effectiveEnd">,
  amountUnits: number,
): Array<{ windowStart: string; windowEnd: string; amountUnits: number }> {
  const startMs = Date.parse(subscription.effectiveStart);
  const endMs = subscription.effectiveEnd ? Date.parse(subscription.effectiveEnd) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new RelayError("invalid_seller_settlement_window", "Prepaid Seller settlement requires a finite positive Subscription period", 500);
  if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) throw new RelayError("invalid_seller_settlement_amount", "Prepaid Seller settlement amount must be a positive integer", 500);
  const durationMs = endMs - startMs;
  const tranches: Array<{ windowStart: string; windowEnd: string; amountUnits: number }> = [];
  let allocatedUnits = 0;
  for (let windowStartMs = startMs; windowStartMs < endMs; windowStartMs += POSTGRES_SELLER_SETTLEMENT_WINDOW_MS) {
    const windowEndMs = windowStartMs + POSTGRES_SELLER_SETTLEMENT_WINDOW_MS;
    const overlapMs = Math.min(endMs, windowEndMs) - windowStartMs;
    const finalTranche = windowEndMs >= endMs;
    const trancheUnits = finalTranche
      ? amountUnits - allocatedUnits
      : Number((BigInt(amountUnits) * BigInt(overlapMs)) / BigInt(durationMs));
    allocatedUnits += trancheUnits;
    tranches.push({ windowStart: new Date(windowStartMs).toISOString(), windowEnd: new Date(windowEndMs).toISOString(), amountUnits: trancheUnits });
  }
  if (allocatedUnits !== amountUnits) throw new Error("seller_settlement_tranche_allocation_invalid");
  return tranches;
}

function creditUnitsFromUsd(amount: number): number {
  if (!Number.isFinite(amount)) throw new RelayError("invalid_credit_amount", "Credit amount must be finite", 400);
  const units = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(units)) throw new RelayError("invalid_credit_amount", "Credit amount is outside supported precision", 400);
  return units;
}

function creditUnitsToUsd(units: number): number {
  if (!Number.isSafeInteger(units)) throw new RelayError("invalid_credit_units", "Credit amount is outside supported precision", 400);
  return units / 1_000_000;
}

function matchesPostgresDirectoryQuery(value: unknown, query: string | undefined, fields: string[]): boolean {
  const normalized = (query ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return fields.some((field) => field.toLowerCase().includes(normalized));
}

function paginatePostgresArray<T>(items: T[], requestedPage?: number, requestedPageSize?: number): { items: T[]; page: number; pageSize: number; total: number; totalPages: number } {
  const pageSize = normalizeDirectoryPageSize(requestedPageSize);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = normalizeDirectoryPage(requestedPage, totalPages);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages };
}

function postgresPlanSubscriptionFilter(filter: Parameters<ApplicationOperationPort["countPlanSubscriptions"]>[0] = {}): { sql: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("$VALUE", `$${values.length}`)); };
  if (filter.subscriptionId) add(`"id" = $VALUE`, filter.subscriptionId);
  if (filter.planId) add(`"plan_id" = $VALUE`, filter.planId);
  if (filter.scopeRef) add(`"scope_ref" = $VALUE`, filter.scopeRef);
  if (filter.scopeType) {
    if (filter.scopeType === "global") clauses.push(`"scope_ref" = 'global:'`);
    else add(`"scope_ref" LIKE $VALUE`, `${filter.scopeType}:%`);
  }
  if (filter.subscriptionLifecycle) add(`"subscription_lifecycle" = $VALUE`, filter.subscriptionLifecycle);
  if (filter.source) add(`"source" = $VALUE`, filter.source);
  if (filter.effectiveState) {
    const at = filter.effectiveAt ?? nowIso();
    if (filter.effectiveState === "current") {
      values.push(at);
      clauses.push(`"subscription_lifecycle" = 'active' AND "effective_start" <= $${values.length} AND ("effective_end" IS NULL OR "effective_end" > $${values.length})`);
    } else if (filter.effectiveState === "future") {
      add(`"subscription_lifecycle" = 'active' AND "effective_start" > $VALUE`, at);
    } else {
      add(`("subscription_lifecycle" <> 'active' OR ("effective_end" IS NOT NULL AND "effective_end" <= $VALUE))`, at);
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

function postgresSha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function postgresDomainBindingSelect(where = ""): string {
  return `SELECT "id", "hostname", "owner_user_id" AS "ownerUserId", "slot_id" AS "slotId",
                  "default_registration_team_id" AS "defaultRegistrationTeamId",
                  "registration_invite_link_id" AS "registrationInviteLinkId", "status",
                  "verification_method" AS "verificationMethod", "verified_at" AS "verifiedAt",
                  "activated_at" AS "activatedAt", "disabled_at" AS "disabledAt", "released_at" AS "releasedAt",
                  "created_at" AS "createdAt", "updated_at" AS "updatedAt"
           FROM "domain_bindings" ${where} ORDER BY "created_at" DESC, "id" DESC`;
}

function encodePostgresWebRegistrationCursor(input: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, name: input.name, id: input.id }), "utf8").toString("base64url");
}

function decodePostgresWebRegistrationCursor(value: string): { name: string; id: string } {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid cursor encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 3 || parsed.v !== 1 || typeof parsed.name !== "string" || typeof parsed.id !== "string" || !parsed.id || parsed.name.length > 100 || parsed.id.length > 200) throw new Error("invalid cursor");
    return { name: parsed.name, id: parsed.id };
  } catch {
    throw new RelayError("invalid_web_registration_team_cursor", "Team candidate cursor is invalid", 400);
  }
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code) === "23505");
}

function postgresRequiredTrimmed(value: unknown, field: string, maxLength = 200): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) throw new RelayError("required_field_invalid", `${field} is required and must not exceed ${maxLength} characters`, 400);
  return text;
}

function postgresRequiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RelayError("invalid_service_commerce_input", `${field} must be a positive safe integer`, 400);
  return Number(value);
}

function postgresTrimNullable(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function postgresRequiredCode(value: unknown, field: string): string {
  const code = postgresRequiredTrimmed(value, field, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{1,63}$/.test(code)) throw new RelayError("invalid_code", `${field} has an invalid format`, 400);
  return code;
}

function postgresPaymentAsset(value: unknown): string {
  const asset = postgresRequiredTrimmed(value, "paymentAsset", 16).toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(asset)) throw new RelayError("invalid_payment_asset", "paymentAsset must be an uppercase asset symbol", 400);
  return asset;
}

function postgresRequiredPaymentUnits(value: unknown, asset: string, field: string): number {
  const units = Number(value);
  if (!Number.isSafeInteger(units) || units <= 0) throw new RelayError("invalid_payment_units", `${field} must be a positive safe integer`, 400);
  if (["CNY", "USD"].includes(asset) && units % 10_000 !== 0) throw new RelayError("invalid_payment_units", `${field} must align to currency cents`, 400);
  return units;
}

function postgresRequiredUsdSettlementUnits(value: unknown, field: string): number {
  const units = Number(value);
  if (!Number.isSafeInteger(units) || units <= 0 || units % 10_000 !== 0) throw new RelayError("invalid_credit_units", `${field} must be a positive USD settlement amount aligned to cents`, 400);
  return units;
}

function postgresControlledIdentifierType(value: unknown): string {
  const type = postgresRequiredCode(value, "recipientIdentifierType");
  if (!["alipay_account", "wallet_address", "bank_account", "email", "phone", "other_account"].includes(type)) throw new RelayError("unsupported_recipient_identifier_type", "Unsupported recipient identifier type", 400);
  return type;
}

function postgresControlledReferenceType(value: unknown): string {
  const type = postgresRequiredCode(value, "transactionReferenceType");
  if (!["trade_number", "tx_hash", "reference", "order_id"].includes(type)) throw new RelayError("unsupported_transaction_reference_type", "Unsupported transaction reference type", 400);
  return type;
}

function postgresAddSeconds(value: string, seconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(seconds) || seconds < 0) throw new RelayError("invalid_timestamp", "Timestamp arithmetic input is invalid", 500);
  return new Date(timestamp + seconds * 1000).toISOString();
}

function postgresValidatePrice(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number }): void {
  for (const field of ["inputPer1M", "cachedInputPer1M", "cacheWritePer1M", "outputPer1M"] as const) {
    const value = price[field];
    if (field === "cacheWritePer1M" && value === null) continue;
    if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new RelayError("invalid_access_point_price", `${field} must be a finite non-negative number`, 400);
  }
}

function postgresNormalizeToggleStatus(value: unknown, fallback = "enabled"): string {
  const status = String(value ?? fallback).trim().toLowerCase();
  if (status !== "enabled" && status !== "disabled") throw new RelayError("invalid_status", "Status must be enabled or disabled", 400);
  return status;
}

function postgresNormalizePlanBillingMode(value: unknown): PlanBillingMode {
  const mode = String(value ?? "prepaid").trim().toLowerCase();
  if (mode === "prepaid" || mode === "included") return "prepaid";
  if (mode === "paygo" || mode === "pay_as_you_go" || mode === "pay-as-you-go") return "paygo";
  throw new RelayError("invalid_plan_billing_mode", "Plan billing mode must be prepaid or paygo", 400);
}

function postgresNormalizePlanStatus(value: unknown): PlanStatus {
  const status = String(value ?? "enabled").trim().toLowerCase();
  if (status === "enabled" || status === "active") return "enabled";
  if (status === "closed") return "closed";
  if (status === "disabled" || status === "inactive" || status === "archived" || status === "paused") return "disabled";
  throw new RelayError("invalid_plan_status", "Plan status must be enabled, closed, or disabled", 400);
}

function postgresNormalizePlanCatalogStatus(value: unknown): PlanCatalogStatus {
  const status = String(value ?? "unlisted").trim().toLowerCase();
  if (status === "listed" || status === "unlisted") return status;
  throw new RelayError("invalid_plan_catalog_status", "Plan catalog status must be listed or unlisted", 400);
}

function postgresValidatePlanTerms(plan: Pick<PlanDefinition, "billingMode" | "purchaseAmount" | "durationSeconds" | "planStatus" | "catalogStatus">): void {
  if (!Number.isFinite(plan.purchaseAmount) || plan.purchaseAmount < 0) throw new RelayError("invalid_plan_purchase_amount", "Plan purchase amount must be non-negative", 400);
  if (!Number.isFinite(plan.durationSeconds) || plan.durationSeconds <= 0) throw new RelayError("invalid_plan_duration", "Plan duration must be greater than 0", 400);
  if (plan.catalogStatus === "listed" && (plan.planStatus !== "enabled" || plan.billingMode !== "prepaid" || usdToCreditUnits(plan.purchaseAmount) <= 0)) {
    throw new RelayError("invalid_listed_plan", "Listed Plan must be enabled prepaid with a positive duration and purchase amount", 409);
  }
}

function postgresPlanTemplate(plan: PlanDefinition): PlanTemplate {
  return {
    id: plan.id, ownerId: plan.ownerId, scopeRef: plan.scopeRef as ScopeRef, name: plan.name, version: plan.version,
    description: plan.description, adminNote: plan.adminNote, billingMode: plan.billingMode as PlanBillingMode,
    purchaseAmount: plan.purchaseAmount, durationSeconds: plan.durationSeconds,
    catalogStatus: plan.catalogStatus, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    status: plan.planStatus,
  } as PlanTemplate;
}

function postgresValidateBudgetPolicy(row: { metric: string; limitValue: number; windowType: string; windowSeconds: number | null }): void {
  if (row.metric !== "tokens" && row.metric !== "amount") throw new RelayError("invalid_budget_metric", "Budget metric must be tokens or amount", 400);
  if (!Number.isFinite(row.limitValue) || row.limitValue <= 0 || (row.metric === "tokens" && !Number.isInteger(row.limitValue))) throw new RelayError("invalid_budget_limit", "Budget limit is invalid", 400);
  if (row.windowType !== "fixed" && row.windowType !== "cumulative") throw new RelayError("invalid_budget_window", "Budget window must be fixed or cumulative", 400);
  if (row.windowType === "fixed" && (!Number.isSafeInteger(row.windowSeconds) || Number(row.windowSeconds) <= 0)) throw new RelayError("invalid_budget_window", "Fixed budget windows require a positive number of seconds", 400);
  if (row.windowType === "cumulative" && row.windowSeconds !== null) throw new RelayError("invalid_budget_window", "Cumulative budget windows cannot have windowSeconds", 400);
}

function postgresAccessPointTargetProjection(target: { type: AccessPointTargetType; targetAccessPointId?: string | null; targetProviderId?: string | null; targetProviderModelName?: string | null }, targetModel: string): Pick<AccessPoint, "targetType" | "targetId" | "targetProviderId" | "targetProviderModelName"> {
  return target.type === "provider-model"
    ? { targetType: "provider-model", targetId: null, targetProviderId: target.targetProviderId ?? null, targetProviderModelName: target.targetProviderModelName ?? targetModel }
    : { targetType: "access-point", targetId: target.targetAccessPointId ?? null, targetProviderId: null, targetProviderModelName: null };
}

function postgresNormalizeAccessPointRequestOverrides(input: unknown) {
  try {
    return normalizeAccessPointRequestOverrides(input);
  } catch (error) {
    throw new RelayError(
      "invalid_access_point_request_overrides",
      error instanceof Error ? error.message : "AccessPoint request overrides are invalid",
      400,
    );
  }
}

function postgresNormalizePriceTiers(tiers: PriceTierInput[], code: string): Array<PriceTierInput & { tierKey: string; serviceTier: string }> {
  const seen = new Set<string>();
  return tiers.map((tier, index) => {
    const tierKey = String(tier.tierKey ?? (Number(tier.minInputTokens) <= 0 ? "short_context" : "long_context")).trim();
    const serviceTier = String(tier.serviceTier ?? "standard").trim();
    const minInputTokens = Number(tier.minInputTokens);
    const maxInputTokens = tier.maxInputTokens === undefined || tier.maxInputTokens === null ? null : Number(tier.maxInputTokens);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(tierKey) || !["standard", "batch", "flex", "priority"].includes(serviceTier) || !Number.isInteger(minInputTokens) || minInputTokens < 0 || (maxInputTokens !== null && (!Number.isInteger(maxInputTokens) || maxInputTokens < minInputTokens))) {
      throw new RelayError(`invalid_${code}`, `Price tier ${index} is invalid`, 400);
    }
    const key = `${serviceTier}:${tierKey}`;
    if (seen.has(key)) throw new RelayError(`invalid_${code}`, `Duplicate price tier key ${key}`, 400);
    seen.add(key);
    postgresValidatePrice(tier);
    return { ...tier, tierKey, serviceTier, minInputTokens, maxInputTokens };
  });
}

function postgresNormalizePaymentIdentifier(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function postgresRejectSensitivePaymentIdentifier(value: string): void {
  if (/\b(?:seed phrase|mnemonic|private key|authorization|bearer)\b/i.test(value) || /\b\d{15,19}\b/.test(value)) {
    throw new RelayError("sensitive_payment_identifier", "Payment identifiers cannot contain secrets or full card numbers", 400);
  }
}

function postgresValidateImageAttachment(contentType: string, byteSize: number): void {
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new RelayError("invalid_credit_topup_attachment_type", "Attachment must be jpeg, png, or webp", 400);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > 5 * 1024 * 1024) throw new RelayError("invalid_credit_topup_attachment_size", "Attachment size is invalid", 400);
}

function postgresNormalizeCardTransferReferenceCode(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) throw new RelayError("invalid_card_transfer_reference_code", "Card transfer reference code must be 1-100 letters, numbers, dots, underscores, colons, or hyphens", 400);
  return normalized;
}

function postgresNormalizeCardTransferNote(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > 500) throw new RelayError("invalid_card_transfer_note", "Card transfer note must be at most 500 characters", 400);
  return normalized;
}

function postgresNormalizeAdminCardExpiration(value: string | null | undefined, createdAt: string): string {
  if (!value) return postgresAddSeconds(createdAt, 2_592_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RelayError("invalid_card_expiration", "Card expiration must be a valid ISO timestamp", 400);
  const expiresAt = new Date(timestamp).toISOString();
  if (expiresAt <= createdAt) throw new RelayError("invalid_card_expiration", "Card expiration must be in the future", 400);
  return expiresAt;
}

function postgresValidateAuthorityCancelReason(value: string, errorCode: string): void {
  if (!["security_response", "fraud", "product_correction", "operator_error"].includes(value)) throw new RelayError(errorCode, "Unsupported Authority cancellation reason", 400);
}

function postgresValidateAuthorityRefundReason(value: string): void {
  if (!["customer_request", "duplicate_purchase", "product_correction", "operator_error"].includes(value)) throw new RelayError("authority_refund_reason_invalid", "Unsupported Authority refund reason", 400);
}

function encodePostgresTeamProviderEntitlementCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodePostgresTeamProviderEntitlementCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new TeamProviderEntitlementCursorError("Invalid Team Provider entitlement cursor");
  }
}

function mapPostgresRow<T>(row: QueryResultRow): T {
  const mapped = Object.fromEntries(Object.entries(row).filter(([key]) => !POSTGRES_INTERNAL_COMPATIBILITY_COLUMNS.has(key)).map(([key, value]) => {
    const camelKey = snakeToCamel(key);
    return [camelKey, postgresResultValue(camelKey, value)];
  }));
  return mapped as T;
}

const POSTGRES_INTERNAL_COMPATIBILITY_COLUMNS = new Set([
  "creation_idempotency_key_hash",
  "creation_request_hash",
  "initial_price",
]);

const POSTGRES_BOOLEAN_COLUMNS = new Set([
  "enabled",
  "outputCommitted",
  "isInternal",
  "useImmediately",
  "livemode",
  "transferOutEnabled",
  "switchEnabled",
  "idempotent",
  "autoExecutable",
]);

function postgresParameterValue(column: string, value: unknown): unknown {
  return POSTGRES_BOOLEAN_COLUMNS.has(column) && typeof value === "boolean" ? (value ? 1 : 0) : value;
}

function postgresResultValue(column: string, value: unknown): unknown {
  if (!POSTGRES_BOOLEAN_COLUMNS.has(column) || value === null || value === undefined) return value;
  return value === true || value === 1 || value === "1";
}

function snakeToCamel(value: string): string {
  return value.replace(/_per_1m$/u, "Per1M").replace(/_([a-z])/gu, (_match, character: string) => character.toUpperCase());
}

function camelToSnake(value: string): string {
  return value.replace(/Per1M$/u, "_per_1m").replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`);
}

function postgresRequiredCardActivationValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new RelayError("card_activation_input_invalid", `${label} is required`, 400);
  return normalized;
}

function postgresNormalizeCardActivationReference(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) throw new RelayError("card_activation_reference_invalid", "Card Activation referenceCode is invalid", 400);
  return normalized;
}

function postgresNormalizeCardActivationQuantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new RelayError("card_activation_quantity_invalid", "Card Activation quantity must be between 1 and 10000", 400);
  return value;
}

function postgresNormalizeCardActivationExpiry(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new RelayError("card_activation_expiry_invalid", "Card Activation redeem expiration must be in the future", 400);
  return new Date(parsed).toISOString();
}

function postgresNormalizeCardActivationReason(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) throw new RelayError("card_activation_reason_invalid", "Card Activation revocation reason is invalid", 400);
  return normalized;
}

function postgresCardActivationPageSize(value: number | undefined): number {
  return Math.max(1, Math.min(200, Math.trunc(value ?? 20)));
}

function postgresEmptyCardActivationStats(): CardActivationStats {
  return { total: 0, available: 0, redeemed: 0, revoked: 0, expired: 0, redemptionRate: 0 };
}

function postgresAddCardActivationStats(target: CardActivationStats, source: CardActivationStats): void {
  target.total += source.total;
  target.available += source.available;
  target.redeemed += source.redeemed;
  target.revoked += source.revoked;
  target.expired += source.expired;
}

function postgresCardActivationCodeStatus(code: CardActivationCode, batch: CardActivationBatch, at: string): CardActivationCodeStatus {
  if (code.redeemedAt) return "redeemed";
  if (code.revokedAt || batch.revokedAt) return "revoked";
  if (batch.redeemExpiresAt <= at) return "expired";
  return "available";
}

function postgresUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code) === "23505");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error("postgres_repository_identifier_invalid");
  return `"${value}"`;
}

function validatePostgresAbuseRateLimitInput(input: {
  bucket: string;
  subjectHashes: string[];
  limit: number;
  windowSeconds: number;
}): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(input.bucket)) throw new Error("Invalid abuse-rate bucket");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("Invalid abuse-rate limit");
  if (!Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1) throw new Error("Invalid abuse-rate window");
  if (!input.subjectHashes.length || [...new Set(input.subjectHashes)].some((subject) => !/^[a-z_]+:[0-9a-f]{64}$/u.test(subject))) {
    throw new Error("Invalid abuse-rate subject hash");
  }
}

function validatePostgresAbuseRateLimitsInput(input: Parameters<ApplicationOperationPort["consumeAbuseRateLimits"]>[0]): Array<{
  id: string;
  bucket: string;
  subjectHashes: string[];
  limit: number;
  windowSeconds: number;
}> {
  if (!input.rules.length || input.rules.length > 8) throw new Error("Invalid abuse-rate rule count");
  if (new Set(input.rules.map((rule) => rule.id)).size !== input.rules.length) throw new Error("Duplicate abuse-rate rule id");
  return input.rules.map((rule) => {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(rule.id)) throw new Error("Invalid abuse-rate rule id");
    validatePostgresAbuseRateLimitInput(rule);
    return { ...rule, subjectHashes: [...new Set(rule.subjectHashes)] };
  });
}

function assertAbuseTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid abuse-rate timestamp");
}

function safePostgresInteger(value: unknown, errorCode: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(errorCode);
  return parsed;
}

function postgresRequestLogFilter(filter: RequestLogListFilter): { sql: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filter.status) clauses.push(`"status" = ${add(filter.status)}`);
  if (filter.userId) clauses.push(`"user_id" = ${add(filter.userId)}`);
  if (filter.teamId) clauses.push(`"team_id" = ${add(filter.teamId)}`);
  if (filter.providerId) clauses.push(`"provider_id" = ${add(filter.providerId)}`);
  if (filter.apiKeyId) clauses.push(`"api_key_id" = ${add(filter.apiKeyId)}`);
  if (filter.ingressHostname) clauses.push(`"ingress_hostname" = ${add(filter.ingressHostname)}`);
  if (filter.model) clauses.push(`("req_model" ILIKE ${add(`%${escapePostgresLike(filter.model)}%`)} ESCAPE '\\' OR "tar_model" ILIKE ${`$${values.length}`} ESCAPE '\\')`);
  if (filter.durationOpen) {
    clauses.push('"ended_at" IS NULL');
  } else if (filter.durationMsGte !== undefined || filter.durationMsLte !== undefined) {
    clauses.push('"ended_at" IS NOT NULL');
    const durationExpression = `EXTRACT(EPOCH FROM ("ended_at"::timestamptz - "started_at"::timestamptz)) * 1000`;
    if (filter.durationMsGte !== undefined) clauses.push(`${durationExpression} >= ${add(filter.durationMsGte)}`);
    if (filter.durationMsLte !== undefined) clauses.push(`${durationExpression} <= ${add(filter.durationMsLte)}`);
  }
  if (filter.startedAtGte) clauses.push(`"started_at" >= ${add(filter.startedAtGte)}`);
  if (filter.startedAtLte) clauses.push(`"started_at" <= ${add(filter.startedAtLte)}`);
  if (filter.cursorStartedAt && filter.cursorId) {
    const cursorStartedAt = add(filter.cursorStartedAt);
    const cursorId = add(filter.cursorId);
    clauses.push(`("started_at" < ${cursorStartedAt} OR ("started_at" = ${cursorStartedAt} AND "id" < ${cursorId}))`);
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

function escapePostgresLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function postgresDerivedPlanSourceOrderId(userId: string, exposedModel: string, planId: string, scopeRef: ScopeRef): string {
  const digest = createHash("md5").update(`${userId}\u001f${exposedModel}\u001f${planId}\u001f${scopeRef}`).digest("hex");
  return `derived_order_${digest}`;
}

function postgresUserApiKeyDirectoryCte(): string {
  return `WITH directory AS (
    SELECT ak."id", ak."user_id" AS "userId", ak."name", ak."key_prefix" AS "keyPrefix", ak."status", ak."created_at" AS "createdAt",
      (SELECT pbl."limit_value" FROM "plan_subscriptions" ps INNER JOIN "plans" p ON p."id" = ps."plan_id" INNER JOIN "plan_budget_limits" pbl ON pbl."plan_id" = p."id"
        WHERE ps."scope_ref" = 'user:' || ak."user_id" AND ps."subscription_lifecycle" = 'active' AND ps."effective_start" <= $2 AND (ps."effective_end" IS NULL OR ps."effective_end" > $2)
          AND p."plan_status" IN ('enabled', 'closed') AND pbl."limit_scope" = 'subscription' AND pbl."metric" = 'amount'
        ORDER BY ps."priority" ASC, ps."effective_start" ASC, ps."created_at" ASC, ps."id" ASC, CASE pbl."window_type" WHEN 'cumulative' THEN 0 ELSE 1 END ASC, pbl."id" ASC LIMIT 1) AS "budgetLimit",
      (SELECT pbl."window_type" FROM "plan_subscriptions" ps INNER JOIN "plans" p ON p."id" = ps."plan_id" INNER JOIN "plan_budget_limits" pbl ON pbl."plan_id" = p."id"
        WHERE ps."scope_ref" = 'user:' || ak."user_id" AND ps."subscription_lifecycle" = 'active' AND ps."effective_start" <= $2 AND (ps."effective_end" IS NULL OR ps."effective_end" > $2)
          AND p."plan_status" IN ('enabled', 'closed') AND pbl."limit_scope" = 'subscription' AND pbl."metric" = 'amount'
        ORDER BY ps."priority" ASC, ps."effective_start" ASC, ps."created_at" ASC, ps."id" ASC, CASE pbl."window_type" WHEN 'cumulative' THEN 0 ELSE 1 END ASC, pbl."id" ASC LIMIT 1) AS "budgetWindowType",
      (SELECT pbl."window_seconds" FROM "plan_subscriptions" ps INNER JOIN "plans" p ON p."id" = ps."plan_id" INNER JOIN "plan_budget_limits" pbl ON pbl."plan_id" = p."id"
        WHERE ps."scope_ref" = 'user:' || ak."user_id" AND ps."subscription_lifecycle" = 'active' AND ps."effective_start" <= $2 AND (ps."effective_end" IS NULL OR ps."effective_end" > $2)
          AND p."plan_status" IN ('enabled', 'closed') AND pbl."limit_scope" = 'subscription' AND pbl."metric" = 'amount'
        ORDER BY ps."priority" ASC, ps."effective_start" ASC, ps."created_at" ASC, ps."id" ASC, CASE pbl."window_type" WHEN 'cumulative' THEN 0 ELSE 1 END ASC, pbl."id" ASC LIMIT 1) AS "budgetWindowSeconds",
      COALESCE((SELECT SUM(be."billable_amount") FROM "billing_history_refs" be INNER JOIN (${POSTGRES_REQUEST_IDENTITY_SOURCE}) rl ON rl."request_id" = be."request_id" WHERE rl."api_key_id" = ak."id"), 0) AS "calculatedCost",
      (SELECT MAX("started_at") FROM (SELECT "started_at" FROM "request_logs" WHERE "api_key_id"=ak."id" UNION ALL SELECT "started_at" FROM "request_log_archive_entries" WHERE "api_key_id"=ak."id") used) AS "lastUsedAt"
    FROM "api_keys" ak
    WHERE ak."user_id" = $1
  )`;
}

function postgresUserAvailableModelDirectoryCte(restrictionSql = "TRUE"): string {
  return `WITH scopes AS (
    SELECT 'global:'::text AS "scopeRef"
    UNION ALL SELECT 'user:' || $1
    UNION ALL
    SELECT 'team:' || membership."team_id"
    FROM "team_memberships" membership
    INNER JOIN "teams" team ON team."id" = membership."team_id" AND team."status" = 'enabled'
    WHERE membership."user_id" = $1
      AND NOT EXISTS (
        SELECT 1 FROM "team_deletion_lifecycles" deletion
        WHERE deletion."team_id" = membership."team_id"
          AND deletion."cancelled_at" IS NULL AND deletion."purged_at" IS NULL
      )
  ), sources AS (
    SELECT subscription."id" AS "subscriptionId", subscription."plan_id" AS "planId",
      subscription."scope_ref" AS "subscriptionScopeRef", subscription."priority" AS "sourcePriority",
      plan."name" AS "planName", access_point."id" AS "accessPointId", access_point."name" AS "displayName",
      access_point."description" AS "description", access_point."api_family" AS "apiFamily",
      access_point."exposed_model" AS "exposedModel", preference."position" AS "preferencePosition",
      preference."id" AS "orderId",
      ROW_NUMBER() OVER (
        PARTITION BY subscription."plan_id", subscription."scope_ref", access_point."exposed_model"
        ORDER BY subscription."priority" ASC, subscription."effective_start" ASC, subscription."created_at" ASC, subscription."id" ASC,
          access_point."priority" ASC, access_point."fallback_order" ASC, access_point."created_at" ASC, access_point."id" ASC
      ) AS "sourcePosition"
    FROM scopes
    INNER JOIN "plan_subscriptions" subscription
      ON subscription."scope_ref" = scopes."scopeRef" AND subscription."subscription_lifecycle" = 'active'
      AND subscription."effective_start" <= $2 AND (subscription."effective_end" IS NULL OR subscription."effective_end" > $2)
      AND ${restrictionSql}
    INNER JOIN "plans" plan ON plan."id" = subscription."plan_id" AND plan."plan_status" IN ('enabled', 'closed')
    INNER JOIN "plan_access_points" relation ON relation."plan_id" = plan."id"
    INNER JOIN "access_points" access_point ON access_point."id" = relation."access_point_id" AND access_point."status" = 'enabled'
    LEFT JOIN "user_model_plan_scope_orders" preference
      ON preference."user_id" = $1 AND preference."exposed_model" = access_point."exposed_model"
      AND preference."plan_id" = subscription."plan_id" AND preference."subscription_scope_ref" = subscription."scope_ref"
  ), ranked_models AS (
    SELECT *, COUNT(*) OVER (PARTITION BY "exposedModel")::int AS "sourceCount", ROW_NUMBER() OVER (
      PARTITION BY "exposedModel"
      ORDER BY CASE WHEN "orderId" IS NULL THEN 1 ELSE 0 END, "preferencePosition" ASC NULLS LAST,
        "orderId" ASC NULLS LAST, "sourcePriority" ASC, "planId" ASC, "subscriptionScopeRef" ASC, "accessPointId" ASC
    ) AS "modelPosition"
    FROM sources WHERE "sourcePosition" = 1
  ), directory AS (
    SELECT "accessPointId", "displayName", "description", "apiFamily", "exposedModel", "subscriptionScopeRef", "planId", "planName", "subscriptionId", "sourceCount"
    FROM ranked_models WHERE "modelPosition" = 1
  )`;
}

function postgresOwnerUserDirectoryCte(): string {
  return `WITH first_membership AS (
    SELECT membership."user_id" AS "userId", membership."team_id" AS "teamId",
      ROW_NUMBER() OVER (PARTITION BY membership."user_id" ORDER BY membership."created_at" ASC, membership."id" ASC) AS "position"
    FROM "team_memberships" membership
  ), directory AS (
    SELECT user_row."id",
      COALESCE(first_membership."teamId", '') AS "teamId",
      COALESCE(team."name", '') AS "teamName",
      identity."email", user_row."status", user_row."admin_note" AS "adminNote",
      user_row."api_key_limit" AS "apiKeyLimit",
      user_row."user_can_create_custom_provider" AS "userCanCreateCustomProvider",
      user_row."user_can_create_access_point" AS "userCanCreateAccessPoint",
      user_row."created_at" AS "createdAt",
      (SELECT COUNT(*)::int FROM "api_keys" api_key WHERE api_key."user_id" = user_row."id") AS "apiKeyCount",
      (SELECT MAX("started_at") FROM (SELECT "started_at" FROM "request_logs" WHERE "user_id"=user_row."id" UNION ALL SELECT "started_at" FROM "request_log_archive_entries" WHERE "user_id"=user_row."id") used) AS "lastSeenAt",
      CASE WHEN EXISTS (
        SELECT 1 FROM "authority_grants" grant_row
        WHERE grant_row."beneficiary_user_id" = user_row."id"
          AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
          AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
      ) THEN 1 ELSE 0 END AS "isPlatformOwner",
      CASE WHEN EXISTS (
        SELECT 1 FROM "teams" owned_team
        WHERE owned_team."owner_id" = user_row."id" AND owned_team."status" = 'enabled'
      ) THEN 1 ELSE 0 END AS "hasTeamRole",
      CASE
        WHEN EXISTS (
          SELECT 1 FROM "authority_grants" grant_row
          WHERE grant_row."beneficiary_user_id" = user_row."id"
            AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
            AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
        ) THEN 'owner'
        WHEN EXISTS (
          SELECT 1 FROM "teams" owned_team
          WHERE owned_team."owner_id" = user_row."id" AND owned_team."status" = 'enabled'
        ) THEN COALESCE((
          SELECT STRING_AGG('owner:' || owned_team."id", ', ' ORDER BY owned_team."id")
          FROM "teams" owned_team
          WHERE owned_team."owner_id" = user_row."id" AND owned_team."status" = 'enabled'
        ), 'member')
        ELSE 'member'
      END AS "roleDetails",
      CASE
        WHEN EXISTS (
          SELECT 1 FROM "authority_grants" grant_row
          WHERE grant_row."beneficiary_user_id" = user_row."id"
            AND grant_row."role_domain" = 'platform' AND grant_row."role_code" = 'owner'
            AND grant_row."source_kind" = 'system_bootstrap' AND grant_row."lifecycle" = 'active'
        ) THEN 0
        WHEN EXISTS (
          SELECT 1 FROM "teams" owned_team
          WHERE owned_team."owner_id" = user_row."id" AND owned_team."status" = 'enabled'
        ) THEN 1
        ELSE 2
      END AS "roleRank"
    FROM "user_controls" user_row
    INNER JOIN "user" identity ON identity."id" = user_row."id"
    LEFT JOIN first_membership ON first_membership."userId" = user_row."id" AND first_membership."position" = 1
    LEFT JOIN "teams" team ON team."id" = first_membership."teamId"
  )`;
}

function postgresAdminTeamDirectoryCte(): string {
  return `WITH member_counts AS (
    SELECT membership."team_id" AS "teamId", COUNT(*)::int AS "memberCount"
    FROM "team_memberships" membership
    GROUP BY membership."team_id"
  ), access_counts AS (
    SELECT access_point."scope_ref" AS "scopeRef", COUNT(*)::int AS "accessCount"
    FROM "access_points" access_point
    WHERE access_point."status" = 'enabled'
    GROUP BY access_point."scope_ref"
  ), directory AS (
    SELECT team."id", team."owner_id" AS "ownerId", team."name", team."status",
      team."team_owner_can_manage_member_api_key_limit" AS "teamOwnerCanManageMemberApiKeyLimit",
      team."team_owner_can_manage_member_credit" AS "teamOwnerCanManageMemberCredit",
      team."team_owner_can_create_custom_provider" AS "teamOwnerCanCreateCustomProvider",
      team."team_owner_can_create_access_point" AS "teamOwnerCanCreateAccessPoint",
      team."invite_email_domain_pattern" AS "inviteEmailDomainPattern",
      team."created_at" AS "createdAt", team."updated_at" AS "updatedAt",
      COALESCE(member_counts."memberCount", 0)::int AS "memberCount",
      COALESCE(team_access."accessCount", 0)::int AS "teamAccessCount",
      COALESCE(global_access."accessCount", 0)::int AS "inheritedAccessCount"
    FROM "teams" team
    LEFT JOIN member_counts ON member_counts."teamId" = team."id"
    LEFT JOIN access_counts team_access ON team_access."scopeRef" = 'team:' || team."id"
    LEFT JOIN access_counts global_access ON global_access."scopeRef" = 'global:'
  )`;
}

function normalizePostgresMembershipRoles(roles: readonly string[]): string[] {
  const allowed = new Set(["viewer", "billing", "manager"]);
  const normalized = [...new Set(roles)].filter((role) => allowed.has(role)).sort();
  return normalized.length > 0 ? normalized : ["viewer"];
}

function postgresLeaseUntil(value: string, seconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(seconds) || seconds < 1) throw new RelayError("request_execution_lease_ttl_invalid", "Request execution lease boundary is invalid", 500);
  return new Date(timestamp + seconds * 1_000).toISOString();
}

function planSourceRestrictionPredicate(
  restriction: ApiKeyPlanSourceRestrictionDecision | undefined,
  planExpression: string,
  scopeExpression: string,
  firstPlaceholder: number,
): { sql: string; params: unknown[] } {
  if (!restriction || restriction.mode === "all") return { sql: "TRUE", params: [] };
  const predicates: string[] = [];
  const params: unknown[] = [];
  let placeholder = firstPlaceholder;
  if (restriction.sourceKeys.length > 0) {
    predicates.push(`EXISTS (
      SELECT 1
      FROM unnest($${placeholder}::text[], $${placeholder + 1}::text[]) AS selected("planId", "scopeRef")
      WHERE selected."planId" = ${planExpression} AND selected."scopeRef" = ${scopeExpression}
    )`);
    params.push(
      restriction.sourceKeys.map((source) => source.planId),
      restriction.sourceKeys.map((source) => source.subscriptionScopeRef),
    );
    placeholder += 2;
  }
  if (restriction.teamScopeRefs.length > 0) {
    predicates.push(`${scopeExpression} = ANY($${placeholder}::text[])`);
    params.push(restriction.teamScopeRefs);
  }
  return { sql: predicates.length > 0 ? `(${predicates.join(" OR ")})` : "FALSE", params };
}
