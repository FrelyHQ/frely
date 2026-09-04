import { randomUUID } from "node:crypto";
import { createPostgresContractVerificationOperations, runApplicationOperationPortContract, type PostgresContractVerificationOperations } from "@frely/application/internal/verification";
import { assertPrismaMigrationsCurrent } from "@frely/postgres/migration-state";
import type { PostgresClientOwner } from "@frely/postgres/server";

export interface PostgresContractResult {
  backend: "postgres";
  migrationHead: string;
  rolledBackFixture: boolean;
  repository: Awaited<ReturnType<typeof runApplicationOperationPortContract>>;
  accessOrders: { rolledBack: boolean; teamSourceResolved: boolean; personalSourceCount: number; duplicateOrderCount: number };
}

/**
 * PostgreSQL repository smoke contract. This entry point keeps the required
 * gate explicit and refuses to report success without a real PG connection.
 */
export async function runPostgresContractGate(owner: PostgresClientOwner): Promise<PostgresContractResult> {
  const repository = createPostgresContractVerificationOperations(owner);
  const schema = await assertPrismaMigrationsCurrent(owner);
  const prefix = `contract_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const contract = await runApplicationOperationPortContract({
    repository,
    withTransaction: (callback) => owner.withTransaction((transaction) => callback(createPostgresContractVerificationOperations(owner, transaction))),
  }, prefix);
  const accessOrders = await runPostgresAccessOrderContract(owner, repository, `${prefix}_orders`);
  return { backend: "postgres", migrationHead: schema.migrationHead, rolledBackFixture: contract.rolledBack, repository: contract, accessOrders };
}

const ACCESS_ORDER_ROLLBACK_SENTINEL = "postgres_access_order_contract_rollback";

async function runPostgresAccessOrderContract(
  clientOwner: PostgresClientOwner,
  repository: PostgresContractVerificationOperations,
  prefix: string,
): Promise<{ rolledBack: boolean; teamSourceResolved: boolean; personalSourceCount: number; duplicateOrderCount: number }> {
  let result: { teamSourceResolved: boolean; personalSourceCount: number; duplicateOrderCount: number } | undefined;
  try {
    await clientOwner.withTransaction(async (context) => {
      const transaction = createPostgresContractVerificationOperations(clientOwner, context);
      const now = new Date().toISOString();
      const ownerTeam = await transaction.upsertTeam({ id: `${prefix}_owner_team`, ownerId: `${prefix}_owner`, name: "Access order owner team" });
      const owner = await transaction.upsertUser({ id: `${prefix}_owner`, teamId: ownerTeam.id, email: `${prefix}_owner@invalid.test`, passwordHash: "contract-only-placeholder", createMembership: false });
      const provider = await transaction.upsertProvider({
        id: `${prefix}_provider`, ownerId: owner.id, scopeRef: "global:", name: "Access order provider", kind: "contract",
        baseUrlResolver: "identity:contract", credentialResolver: "identity:contract", modelsResolver: "identity:contract",
      });
      for (const model of ["access-order-model", "access-order-model-2"]) {
        await transaction.upsertProviderModel({ id: `${prefix}_${model}`, providerId: provider.id, providerModelName: model, displayName: model });
        await transaction.createProviderModelCost({ providerId: provider.id, providerModelName: model, inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1 });
      }
      const firstAccessPoint = await transaction.createAccessPoint({
        ownerId: owner.id, scopeRef: "global:", name: "Access order model", apiFamily: "openai", exposedModel: "access-order-model",
        targetModel: "access-order-model", targetType: "provider-model", targetProviderId: provider.id, targetProviderModelName: "access-order-model",
      });
      const plan = await transaction.createPlanDefinition({
        id: `${prefix}_plan`, ownerId: owner.id, scopeRef: "global:", name: "Access order plan", durationSeconds: 3_600,
        accessPointIds: [firstAccessPoint.id],
      });

      const team = await transaction.upsertTeam({ id: `${prefix}_team`, ownerId: owner.id, name: "Access order team" });
      const member = await transaction.upsertUser({ id: `${prefix}_member`, teamId: team.id, email: `${prefix}_member@invalid.test`, passwordHash: "contract-only-placeholder", createMembership: false });
      await transaction.createPlanSubscription({ planId: plan.id, scopeRef: `team:${team.id}`, effectiveStart: now });
      await transaction.grantTeamMembership(team.id, member.id);
      const teamSources = await transaction.pageOrderedPlanSourcesForUser(member.id, "access-order-model", null, now);
      if (!teamSources.items[0]?.subscription || !teamSources.items[0]?.accessPoint) throw new Error("postgres_access_order_team_source_missing");

      const personal = await transaction.upsertUser({ id: `${prefix}_personal`, teamId: team.id, email: `${prefix}_personal@invalid.test`, passwordHash: "contract-only-placeholder", createMembership: false });
      const firstSubscription = await transaction.createPlanSubscription({ planId: plan.id, scopeRef: `user:${personal.id}`, effectiveStart: now });
      const persistedBeforeExplicitOrder = await transaction.listUserModelPlanScopeOrders(personal.id, "access-order-model");
      if (persistedBeforeExplicitOrder.length !== 0) throw new Error("postgres_access_order_query_wrote_preference");
      const firstProjection = (await transaction.pageOrderedPlanSourcesForUser(personal.id, "access-order-model", null, now)).items[0];
      if (!firstProjection?.subscription) throw new Error("postgres_access_order_personal_source_missing");
      await transaction.cancelPlanSubscription(firstSubscription.id, new Date(Date.parse(now) + 1).toISOString());
      const renewedSubscription = await transaction.createPlanSubscription({ planId: plan.id, scopeRef: `user:${personal.id}`, effectiveStart: new Date(Date.parse(now) + 2).toISOString() });
      const renewedProjection = (await transaction.pageOrderedPlanSourcesForUser(personal.id, "access-order-model", null, new Date(Date.parse(now) + 3).toISOString())).items[0];
      if (!renewedProjection?.subscription
        || renewedProjection.order.id !== firstProjection.order.id
        || renewedProjection.order.position !== firstProjection.order.position
        || renewedProjection.subscription.id !== renewedSubscription.id) {
        throw new Error("postgres_access_order_renewal_reordered");
      }

      const secondAccessPoint = await transaction.createAccessPoint({
        ownerId: owner.id, scopeRef: "global:", name: "Access order model two", apiFamily: "openai", exposedModel: "access-order-model-2",
        targetModel: "access-order-model-2", targetType: "provider-model", targetProviderId: provider.id, targetProviderModelName: "access-order-model-2", status: "disabled",
      });
      await transaction.updatePlanTemplate(plan.id, { accessPointIds: [firstAccessPoint.id, secondAccessPoint.id] });
      await transaction.updateAccessPointAdmin(secondAccessPoint.id, {
        ownerId: secondAccessPoint.ownerId, scopeRef: secondAccessPoint.scopeRef as `global:` | `team:${string}` | `user:${string}` | `key:${string}`, name: secondAccessPoint.name,
        description: secondAccessPoint.description, apiFamily: secondAccessPoint.apiFamily, exposedModel: secondAccessPoint.exposedModel,
        targetModel: secondAccessPoint.targetModel, targetType: secondAccessPoint.targetType as "access-point" | "provider-model", targetId: secondAccessPoint.targetId,
        targetProviderId: secondAccessPoint.targetProviderId, targetProviderModelName: secondAccessPoint.targetProviderModelName,
        priority: secondAccessPoint.priority, weight: secondAccessPoint.weight, fallbackOrder: secondAccessPoint.fallbackOrder, status: "enabled",
      });
      const personalSources = await transaction.pageOrderedPlanSourcesForUser(personal.id, "access-order-model-2", null, new Date(Date.parse(now) + 3).toISOString());
      if (!personalSources.items[0]?.subscription || !personalSources.items[0]?.accessPoint) throw new Error("postgres_access_order_plan_access_point_source_missing");

      const concurrent = await transaction.upsertUser({ id: `${prefix}_concurrent`, teamId: team.id, email: `${prefix}_concurrent@invalid.test`, passwordHash: "contract-only-placeholder", createMembership: false });
      await Promise.all(Array.from({ length: 4 }, () => transaction.grantTeamMembership(team.id, concurrent.id)));
      const concurrentProjections = (await transaction.pageOrderedPlanSourcesForUser(concurrent.id, "access-order-model", null, now)).items;
      const duplicateOrderCount = concurrentProjections.length - new Set(concurrentProjections.map((projection) => projection.order.id)).size;
      if (concurrentProjections.length !== 1 || duplicateOrderCount !== 0) throw new Error("postgres_access_order_duplicate_projection");
      result = { teamSourceResolved: true, personalSourceCount: personalSources.items.length, duplicateOrderCount };
      throw new Error(ACCESS_ORDER_ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ACCESS_ORDER_ROLLBACK_SENTINEL) throw error;
  }
  if (!result) throw new Error("postgres_access_order_contract_result_missing");
  return { ...result, rolledBack: true };
}
