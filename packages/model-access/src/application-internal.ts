import { createId, RelayError } from "@frely/core";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import type { ModelAccessAuditAppender } from "./audit-contract.js";
import { ModelAccessCommandService } from "./commands.js";
import { ModelAccessManagementQueryService, type ModelAccessReadOwner } from "./management-readback.js";
import { ModelAccessRoutingQueryService } from "./routing-queries.js";
import { ModelAccessIdentityMigrationQueries } from "./server.js";
import type {
  ModelAccessCommands,
  ModelAccessManagementQueries,
  ModelAccessQueries,
  ModelAccessRoutingQueries,
} from "./public-contracts.js";
import type { AccessPointCreationAdmission } from "./commands.js";

export interface BoundPersonalProviderModelAccessParticipant {
  getPersonalProvider(providerId: string, userId: string): ReturnType<typeof import("./provider-management.js").getPersonalCodexProvider>;
  createPersonalProvider(input: { slotId: string; userId: string; name: string }, audit: import("./audit-contract.js").ModelAccessAuditInput): ReturnType<typeof import("./provider-management.js").createPersonalCodexProvider>;
  changePersonalProviderModel(input: { providerId: string; providerModelName: string; displayName?: string; status?: "enabled" | "disabled" }, audit: import("./audit-contract.js").ModelAccessAuditInput): ReturnType<typeof import("./provider-management.js").changeProviderModel>;
  createAccessPoint(command: import("./public-contracts.js").CreateAccessPointCommand, audit: import("./audit-contract.js").ModelAccessAuditInput, admission: AccessPointCreationAdmission): ReturnType<typeof import("./commands.js").createAccessPointWithAdmission>;
  createPersonalAccessPoint(slot: { id: string; userId: string; providerId: string | null; lifecycle: "active" }, command: Omit<import("./public-contracts.js").CreateAccessPointCommand, "ownerId" | "scopeRef">, audit: import("./audit-contract.js").ModelAccessAuditInput, admission: AccessPointCreationAdmission): ReturnType<typeof import("./commands.js").createPersonalProviderAccessPoint>;
  changePersonalAccessPointStatus(input: { slotId: string; userId: string; accessPointId: string; status: "enabled" | "disabled"; slotLifecycle: string }, audit: import("./audit-contract.js").ModelAccessAuditInput): Promise<Awaited<ReturnType<typeof import("./commands.js").changeAccessPoint>>>;
  removePersonalAccessPoint(input: { slotId: string; userId: string; accessPointId: string }, audit: import("./audit-contract.js").ModelAccessAuditInput): ReturnType<typeof import("./commands.js").removeAccessPoint>;
}

export function bindPersonalProviderModelAccessParticipant(
  transaction: Prisma.TransactionClient,
  auditAppender: ModelAccessAuditAppender,
): BoundPersonalProviderModelAccessParticipant {
  const participant: BoundPersonalProviderModelAccessParticipant = {
    getPersonalProvider: (providerId, userId) => import("./provider-management.js").then(({ getPersonalCodexProvider }) => getPersonalCodexProvider(transaction, providerId, userId)),
    createPersonalProvider: (input, audit) => import("./provider-management.js").then(({ createPersonalCodexProvider }) => createPersonalCodexProvider(transaction, {
      id: createId("prv"),
      slotId: input.slotId,
      userId: input.userId,
      name: input.name,
      providerId: null,
      lifecycle: "active",
    }, audit, auditAppender)),
    changePersonalProviderModel: (input, audit) => import("./provider-management.js").then(({ changeProviderModel }) => changeProviderModel(transaction, input.providerId, input.providerModelName, {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.status === undefined ? {} : { status: input.status }),
    }, audit, auditAppender)),
    createAccessPoint: (command, audit, admission) => import("./commands.js").then(({ createAccessPointWithAdmission }) => createAccessPointWithAdmission(transaction, command, audit, auditAppender, admission)),
    createPersonalAccessPoint: (slot, command, audit, admission) => import("./commands.js").then(({ createPersonalProviderAccessPoint }) => createPersonalProviderAccessPoint(transaction, slot, command, audit, auditAppender, admission)),
    changePersonalAccessPointStatus: async (input, audit) => {
      const accessPoint = await transaction.accessPoint.findUnique({ where: { id: input.accessPointId }, include: { targets: { where: { removedAt: null }, orderBy: [{ position: "asc" }, { id: "asc" }] } } });
      if (!accessPoint || accessPoint.personalProviderSlotId !== input.slotId || accessPoint.ownerId !== input.userId || accessPoint.removedAt) throw new RelayError("access_point_not_found", "Personal AccessPoint not found", 404);
      if (input.status === "enabled" && input.slotLifecycle !== "active") throw new RelayError("provider_slot_inactive", "Renew this Provider slot before enabling AccessPoints", 403);
      const { changeAccessPoint } = await import("./commands.js");
      return changeAccessPoint(transaction, accessPoint.id, {
        name: accessPoint.name, description: accessPoint.description, apiFamily: accessPoint.apiFamily,
        exposedModel: accessPoint.exposedModel, targetModel: accessPoint.targetModel,
        routing: {
          expectedRoutingRevision: accessPoint.routingRevision,
          selector: { id: accessPoint.routingRuleId as "direct", behaviorVersion: 1, config: JSON.parse(accessPoint.routingRuleConfigJson) as Record<string, unknown> },
          requestOverrides: JSON.parse(accessPoint.requestOverridesJson) as Record<string, unknown>,
          targets: accessPoint.targets.map((target) => ({
            id: target.id, type: target.targetType as "provider-model", targetAccessPointId: target.targetAccessPointId,
            targetProviderId: target.targetProviderId, targetProviderModelName: target.targetProviderModelName,
            position: target.position, status: target.status as "enabled" | "disabled",
          })),
        },
        priority: accessPoint.priority, weight: accessPoint.weight, fallbackOrder: accessPoint.fallbackOrder, status: input.status,
      }, audit, auditAppender);
    },
    removePersonalAccessPoint: async (input, audit) => {
      const accessPoint = await transaction.accessPoint.findUnique({ where: { id: input.accessPointId } });
      if (!accessPoint || accessPoint.personalProviderSlotId !== input.slotId || accessPoint.ownerId !== input.userId) throw new RelayError("access_point_not_found", "Personal AccessPoint not found", 404);
      const { removeAccessPoint } = await import("./commands.js");
      return removeAccessPoint(transaction, accessPoint.id, audit, auditAppender);
    },
  };
  return Object.freeze(participant);
}

export interface ModelAccessApplicationCapabilities {
  readonly queries: ModelAccessQueries;
  readonly commands: ModelAccessCommands;
  readonly managementQueries: ModelAccessManagementQueries;
  readonly routingQueries: ModelAccessRoutingQueries;
}

export function createModelAccessApplicationCapabilities(
  owner: PrismaTransactionOwner & ModelAccessReadOwner,
  auditAppender: ModelAccessAuditAppender,
): ModelAccessApplicationCapabilities {
  const commands = new ModelAccessCommandService(owner, auditAppender);
  const managementQueries = new ModelAccessManagementQueryService(owner);
  const routingQueries = new ModelAccessRoutingQueryService(owner);
  const queries: ModelAccessQueries = Object.freeze({
    getProvider: managementQueries.getProvider.bind(managementQueries),
    listProvidersByIds: managementQueries.listProvidersByIds.bind(managementQueries),
    getProviderModel: managementQueries.getProviderModel.bind(managementQueries),
    listProviderModels: managementQueries.listProviderModels.bind(managementQueries),
    hasEnabledProviderModel: managementQueries.hasEnabledProviderModel.bind(managementQueries),
    pageProviderModels: managementQueries.pageProviderModels.bind(managementQueries),
    getAccessPointWithRouting: managementQueries.getAccessPointWithRouting.bind(managementQueries),
    inspectAccessPointRouting: routingQueries.inspectAccessPointRouting.bind(routingQueries),
    evaluateGatewayRouting: routingQueries.evaluateGatewayRouting.bind(routingQueries),
    evaluateEntryRouting: routingQueries.evaluateEntryRouting.bind(routingQueries),
  });
  if ((queries as object) === (commands as object)) throw new Error("model_access_capability_identity_reused");
  return Object.freeze({ queries, commands, managementQueries, routingQueries });
}

export {
  ModelAccessCommandService,
  ModelAccessManagementQueryService,
  ModelAccessRoutingQueryService,
};
export {
  changeAccessPoint,
  createAccessPointWithAdmission,
  createPersonalProviderAccessPoint,
  removeAccessPoint,
} from "./commands.js";
export type { AccessPointCreationAdmission } from "./commands.js";
export {
  changeProviderModel,
  createPersonalCodexProvider,
  getPersonalCodexProvider,
  ProviderManagementCommandService,
} from "./provider-management.js";
export type { ModelAccessAuditAppender } from "./audit-contract.js";

export function createModelAccessIdentityMigrationQueries(transaction: Prisma.TransactionClient) {
  return new ModelAccessIdentityMigrationQueries(transaction);
}
