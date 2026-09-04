import { randomUUID } from "node:crypto";
import { createApiKey } from "@frely/auth";
import { usdToCreditUnits, type ApplicationOperationPort } from "@frely/application/runtime";
import { encryptProviderCredential, setProviderCredentialConfig } from "@frely/providers";
import { privatePlanBudgetLimit } from "@frely/testkit";

process.env.FRIDAY_RELAY_SECRET_KEY ??= "friday-relay-test-secret-key-material";

export const requiredDomainPipelineInvocations = [
  { pluginId: "plan-subscription-selection", behaviorVersion: 1, hook: "access.candidates", instanceRevision: "builtin-1", outcome: "applied" },
  { pluginId: "access-resolution", behaviorVersion: 1, hook: "access.select", instanceRevision: "builtin-1", outcome: "applied" },
  { pluginId: "pricing-quote", behaviorVersion: 1, hook: "pricing.quote", instanceRevision: "builtin-1", outcome: "applied" },
  { pluginId: "budget-enforcement", behaviorVersion: 1, hook: "pricing.quote", instanceRevision: "builtin-1", outcome: "applied" },
  { pluginId: "billing-calculation", behaviorVersion: 1, hook: "billing.calculate", instanceRevision: "builtin-1", outcome: "applied" },
] as const;

export function providerConfigWithCredential(apiKey = "provider-test-key") {
  return setProviderCredentialConfig("{}", encryptProviderCredential("api-key", { apiKey }));
}
export function createAccessPoint(repo: ApplicationOperationPort, input: Record<string, unknown>) {
  const exposedModel = inferTestExposedModel(repo, input);
  const targetModel = inferTestTargetModel(repo, input, exposedModel);
  const targetType = input.targetType === "access-point" ? "access-point" : "provider-model";
  const targetProviderId = targetType === "provider-model" ? String(input.targetProviderId ?? "") : null;
  const targetProviderModelName = targetType === "provider-model" ? String(input.targetProviderModelName ?? targetModel) : null;
  if (targetProviderId && targetProviderModelName && !repo.getProviderModel(targetProviderId, targetProviderModelName)) {
    repo.upsertProviderModel({ providerId: targetProviderId, providerModelName: targetProviderModelName, displayName: targetProviderModelName });
  }
  if (targetProviderId && !repo.getProviderBinding(targetProviderId)) {
    repo.upsertProviderBinding({
      providerId: targetProviderId,
      authMethod: "api-key",
      credentialOwnership: "cpa-managed",
      credentialRefsJson: JSON.stringify([`test-ref:${targetProviderId}`]),
      credentialPreview: "tes...-ref",
      syncStatus: "ready"
    });
  }
  return repo.createAccessPoint({
    ...input,
    exposedModel,
    targetModel,
    targetType,
    targetId: targetType === "access-point" ? String(input.targetId ?? "") : null,
    targetProviderId,
    targetProviderModelName
  } as never);
}

function inferTestExposedModel(repo: ApplicationOperationPort, input: Record<string, unknown>): string {
  if (input.exposedModel) return String(input.exposedModel);
  if (input.sourceModelMatch) return String(input.sourceModelMatch);
  if (input.aliasModel) return String(input.aliasModel);
  const resolver = String(input.sourceModelListResolver ?? "");
  if (resolver.startsWith("literal:list:")) return resolver.slice("literal:list:".length).split(",")[0]?.trim() ?? "";
  if (input.targetType === "access-point" && input.targetId) return repo.getAccessPoint(String(input.targetId))?.exposedModel ?? "";
  return String(input.targetProviderModelName ?? input.targetModel ?? "");
}

function inferTestTargetModel(repo: ApplicationOperationPort, input: Record<string, unknown>, exposedModel: string): string {
  if (input.targetModel) return String(input.targetModel);
  const resolver = String(input.targetModelResolver ?? "request:model");
  if (resolver.startsWith("literal:")) return resolver.slice("literal:".length);
  if (input.targetType === "access-point" && input.targetId) return repo.getAccessPoint(String(input.targetId))?.exposedModel ?? exposedModel;
  return exposedModel;
}

export function principalFixture(repo: ApplicationOperationPort, options: { creditBalance?: number } = {}) {
  const team = repo.upsertTeam({ id: `team_${randomUUID()}`, name: "Gateway Pricing" });
  const user = repo.upsertUser({ id: `user_${randomUUID()}`, teamId: team.id, email: `${randomUUID()}@example.local`, passwordHash: "hash" });
  const keyMaterial = createApiKey();
  const apiKey = repo.createApiKey({ teamId: team.id, userId: user.id, name: "key", keyHash: keyMaterial.hash, keyPrefix: keyMaterial.prefix, keyValue: keyMaterial.raw });
  const creditAccount = repo.createCreditAccount({ scopeRef: `user:${user.id}` });
  const creditBalance = options.creditBalance ?? 1;
  if (creditBalance > 0) {
    repo.createCreditLedgerEvent({ accountId: creditAccount.id, eventType: "grant", amountUnits: usdToCreditUnits(creditBalance), transferId: null, relatedEventId: null, planSubscriptionId: null, billingEventId: null, fromAccountId: null, toAccountId: creditAccount.id, reason: "test-credit", actorUserId: null });
  }
  return { team, user, apiKey };
}

export function providerAndAccess(repo: ApplicationOperationPort) {
  const provider = repo.upsertProvider({ ownerId: "test_resource_owner",
    id: `provider_${randomUUID()}`,
    scopeRef: "global:",
    name: "Provider",
    kind: "openai",
    baseUrlResolver: "literal:https://provider.example/v1",
    credentialResolver: "api-key:",
    modelsResolver: "literal:list:target-model",
    configJson: providerConfigWithCredential()
  });
  const cost = repo.createProviderModelCost({ providerId: provider.id, providerModelName: "target-model", inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 2 });
  const accessPoint = createAccessPoint(repo, { ownerId: "test_resource_owner",
    scopeRef: "global:",
    name: "fast",
    apiFamily: "openai-compatible",
    mode: "transform",
    sourceModelListResolver: "literal:list:fast",
    targetModelResolver: "literal:target-model",
    targetType: "provider-model",
    targetProviderId: provider.id,
    targetProviderModelName: "target-model",
    priority: 1
  });
  return { provider, accessPoint, cost };
}

export function createPlanWithAmountLimit(repo: ApplicationOperationPort, scopeRef: "global:" | `team:${string}` | `user:${string}`, limitValue: number) {
  const policy = repo.createBudgetPolicy({ metric: "amount", limitValue, windowType: "cumulative" });
  const plan = repo.createPlanDefinition({ name: `Plan ${randomUUID()}`, durationSeconds: 31_536_000, budgetLimits: [privatePlanBudgetLimit(policy, "subscription")], accessPointIds: repo.listAccessPointsVisibleToScope(scopeRef).map((accessPoint) => accessPoint.id) });
  return repo.createPlanSubscription({ planId: plan.id, scopeRef, effectiveStart: "2026-01-01T00:00:00.000Z" });
}
