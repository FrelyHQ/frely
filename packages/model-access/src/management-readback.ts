import {
  parseAccessPointRequestOverridesJson,
  parseJsonText,
  RelayError,
  type AccessPointSelectorId,
  type AccessPointTargetType,
  type ScopeRef,
} from "@frely/core";
import type { PrismaClient } from "@frely/postgres/server";
import type {
  AccessPointManagementView,
  ProviderManagementView,
  ProviderModelManagementPage,
  ProviderModelManagementView,
} from "./public-contracts.js";

export type {
  AccessPointManagementTarget,
  AccessPointManagementView,
  ProviderManagementView,
  ProviderModelManagementPage,
  ProviderModelManagementView,
} from "./public-contracts.js";

const PROVIDER_MODEL_READ_LIMIT = 8192;

export interface ModelAccessReadOwner {
  prisma: PrismaClient;
}

export class ModelAccessManagementQueryService {
  constructor(private readonly owner: ModelAccessReadOwner) {}

  async getProvider(id: string): Promise<ProviderManagementView | undefined> {
    const row = await this.owner.prisma.providers.findUnique({ where: { id } });
    return row ? providerManagementView(row) : undefined;
  }

  async listProvidersByIds(providerIds: readonly string[]): Promise<ProviderManagementView[]> {
    const ids = [...new Set(providerIds)];
    if (ids.length > 200) throw new RelayError("provider_summary_collection_too_large", "Provider summary read is limited to 200 Providers", 400);
    if (ids.length === 0) return [];
    const rows = await this.owner.prisma.providers.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    return rows.map(providerManagementView);
  }

  async getProviderModel(providerId: string, providerModelName: string): Promise<ProviderModelManagementView | undefined> {
    const rows = await this.owner.prisma.provider_models.findMany({
      where: { provider_id: providerId, provider_model_name: providerModelName },
      orderBy: { id: "asc" },
      take: 2,
    });
    if (rows.length > 1) {
      throw new RelayError("provider_model_identity_ambiguous", `Provider model ${providerId}/${providerModelName} has duplicate identities`, 409);
    }
    return rows[0] ? providerModelManagementView(rows[0]) : undefined;
  }

  async listProviderModels(input: { providerIds?: readonly string[]; status?: string } = {}): Promise<ProviderModelManagementView[]> {
    if (input.providerIds && input.providerIds.length === 0) return [];
    const rows = await this.owner.prisma.provider_models.findMany({
      where: {
        ...(input.providerIds ? { provider_id: { in: [...new Set(input.providerIds)] } } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: [{ provider_id: "asc" }, { provider_model_name: "asc" }, { id: "asc" }],
      take: PROVIDER_MODEL_READ_LIMIT + 1,
    });
    if (rows.length > PROVIDER_MODEL_READ_LIMIT) {
      throw new RelayError("provider_model_collection_too_large", "Provider model collection requires paged readback", 409);
    }
    assertUniqueProviderModelViews(rows);
    return rows.map(providerModelManagementView);
  }

  async hasEnabledProviderModel(providerId: string): Promise<boolean> {
    const rows = await this.owner.prisma.provider_models.findMany({
      where: { provider_id: providerId },
      select: { id: true, provider_id: true, provider_model_name: true, status: true },
      orderBy: [{ provider_model_name: "asc" }, { id: "asc" }],
    });
    assertUniqueProviderModelViews(rows);
    return rows.some((row) => row.status === "enabled");
  }

  async pageProviderModels(
    page = 1,
    pageSize = 20,
    input: { providerIds?: readonly string[]; status?: string } = {},
  ): Promise<ProviderModelManagementPage> {
    const safePage = positiveInteger(page, "page");
    const safePageSize = positiveInteger(pageSize, "pageSize");
    if (safePageSize > 200) throw new RelayError("invalid_pagination", "pageSize must not exceed 200", 400);
    const providerIds = input.providerIds ? [...new Set(input.providerIds)] : undefined;
    if (providerIds?.length === 0) {
      return { items: [], page: safePage, pageSize: safePageSize, total: 0, totalPages: 1 };
    }
    const duplicate = await this.owner.prisma.$queryRaw<Array<{ providerId: string; providerModelName: string }>>`
      SELECT "provider_id" AS "providerId", "provider_model_name" AS "providerModelName"
      FROM "provider_models"
      GROUP BY "provider_id", "provider_model_name"
      HAVING COUNT(*) > 1
      LIMIT 1
    `;
    if (duplicate[0]) {
      throw new RelayError("provider_model_identity_ambiguous", `Provider model ${duplicate[0].providerId}/${duplicate[0].providerModelName} has duplicate identities`, 409);
    }
    const where = {
      ...(providerIds ? { provider_id: { in: providerIds } } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.owner.prisma.provider_models.count({ where }),
      this.owner.prisma.provider_models.findMany({
        where,
        orderBy: [{ provider_id: "asc" }, { provider_model_name: "asc" }, { id: "asc" }],
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
      }),
    ]);
    assertUniqueProviderModelViews(rows);
    return {
      items: rows.map(providerModelManagementView),
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  async getAccessPointWithRouting(id: string): Promise<AccessPointManagementView | undefined> {
    const row = await this.owner.prisma.accessPoint.findFirst({
      where: { id, removedAt: null },
      select: {
        id: true,
        ownerId: true,
        scopeRef: true,
        name: true,
        description: true,
        apiFamily: true,
        exposedModel: true,
        targetModel: true,
        routingRuleId: true,
        routingRuleBehaviorVersion: true,
        routingRuleConfigJson: true,
        requestOverridesJson: true,
        routingRevision: true,
        legacyTargetType: true,
        legacyTargetId: true,
        legacyTargetProviderId: true,
        legacyTargetProviderModelName: true,
        priority: true,
        weight: true,
        fallbackOrder: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        targets: {
          where: { removedAt: null },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: {
            id: true,
            accessPointId: true,
            targetType: true,
            targetAccessPointId: true,
            targetProviderId: true,
            targetProviderModelName: true,
            targetProviderModelId: true,
            position: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!row) return undefined;

    const selectorId = row.routingRuleId as AccessPointSelectorId;
    const behaviorVersion = row.routingRuleBehaviorVersion as 1;
    const targets = row.targets.map((target) => ({
      ...target,
      targetType: target.targetType as AccessPointTargetType,
    }));
    return {
      id: row.id,
      ownerId: row.ownerId,
      scopeRef: row.scopeRef as ScopeRef,
      name: row.name,
      description: row.description,
      apiFamily: row.apiFamily,
      exposedModel: row.exposedModel,
      targetModel: row.targetModel,
      selectorId,
      selectorBehaviorVersion: behaviorVersion,
      selectorConfigJson: row.routingRuleConfigJson,
      requestOverridesJson: row.requestOverridesJson,
      routingRevision: row.routingRevision,
      targetType: row.legacyTargetType as AccessPointTargetType,
      targetId: row.legacyTargetId,
      targetProviderId: row.legacyTargetProviderId,
      targetProviderModelName: row.legacyTargetProviderModelName,
      priority: row.priority,
      weight: row.weight,
      fallbackOrder: row.fallbackOrder,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      routing: {
        selector: {
          id: selectorId,
          behaviorVersion,
          config: parseJsonText(row.routingRuleConfigJson, {}),
        },
        requestOverrides: parseAccessPointRequestOverridesJson(row.requestOverridesJson),
        targets,
        routingRevision: row.routingRevision,
      },
    };
  }
}

function providerManagementView(row: {
  id: string;
  owner_id: string;
  scope_ref: string;
  name: string;
  kind: string;
  status: string;
  base_url_resolver: string;
  credential_resolver: string;
  models_resolver: string;
  config_json: string;
  cpa_instance_id: string;
  created_at: string;
  updated_at: string;
}): ProviderManagementView {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scopeRef: row.scope_ref as ScopeRef,
    name: row.name,
    kind: row.kind,
    status: row.status,
    baseUrlResolver: row.base_url_resolver,
    credentialResolver: row.credential_resolver,
    modelsResolver: row.models_resolver,
    configJson: row.config_json,
    cpaInstanceId: row.cpa_instance_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerModelManagementView(row: {
  id: string;
  provider_id: string;
  provider_model_name: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}): ProviderModelManagementView {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerModelName: row.provider_model_name,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertUniqueProviderModelViews(rows: Array<{ id: string; provider_id: string; provider_model_name: string }>): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.provider_id}\u0000${row.provider_model_name}`;
    if (keys.has(key)) {
      throw new RelayError("provider_model_identity_ambiguous", `Provider model ${row.provider_id}/${row.provider_model_name} has duplicate identities`, 409);
    }
    keys.add(key);
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RelayError("invalid_pagination", `${field} must be a positive integer`, 400);
  return value;
}
