import { type ScopeRef } from "@frely/core";
import type { Provider, ProviderModel, ApplicationOperationPort } from "@frely/application/runtime";
import { encryptProviderCredential, setProviderCredentialConfig } from "@frely/providers";
import { privatePlanBudgetLimit } from "@frely/testkit";

process.env.FRIDAY_RELAY_SECRET_KEY ??= "friday-relay-test-secret-key-material";

export function fakeCodexAccessToken() {
  const payload = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }));
  return `e30.${payload}.sig`;
}
export function providerConfigWithCredential(type: "api-key" | "oauth" | "identity", payload: Record<string, unknown>, config: Record<string, unknown> = {}) {
  return setProviderCredentialConfig(JSON.stringify(config), encryptProviderCredential(type, payload));
}

export function upsertTestProvider(repo: ApplicationOperationPort, id: string, input: { apiKey?: string; baseUrl?: string } = {}) {
  const provider = repo.upsertProvider({ ownerId: "test_resource_owner",
    id,
    scopeRef: "global:",
    name: id,
    kind: "openai",
    status: "enabled",
    baseUrlResolver: `literal:${input.baseUrl ?? ""}`,
    credentialResolver: "api-key:",
    modelsResolver: "literal:list:provider-model",
    configJson: providerConfigWithCredential("api-key", { apiKey: input.apiKey ?? `${id}-provider-key` })
  });
  if (!repo.getProviderBinding(id)) {
    repo.upsertProviderBinding({
      providerId: id,
      authMethod: "api-key",
      credentialOwnership: "cpa-managed",
      credentialRefsJson: JSON.stringify([`test-ref:${id}`]),
      credentialPreview: "tes...-ref",
      syncStatus: "ready"
    });
  }
  return provider;
}

export function grantTestPlan(repo: ApplicationOperationPort, scopeRef: ScopeRef, visibleToScopeRef: ScopeRef = scopeRef) {
  const policy = repo.createBudgetPolicy({ metric: "tokens", limitValue: 1_000_000_000, windowType: "rolling", windowSeconds: 86_400 });
  const template = repo.createPlan({ name: `Test Plan ${scopeRef}`, durationSeconds: 31_536_000, budgetLimits: [privatePlanBudgetLimit(policy, "subscription")], accessPointIds: repo.listAccessPointsVisibleToScope(visibleToScopeRef).map((accessPoint) => accessPoint.id) });
  return repo.createPlan({ planTemplateId: template.id, scopeRef });
}

export function grantTestPaygoPlan(repo: ApplicationOperationPort, scopeRef: ScopeRef, visibleToScopeRef: ScopeRef = scopeRef) {
  const policy = repo.createBudgetPolicy({ metric: "tokens", limitValue: 1_000_000_000, windowType: "rolling", windowSeconds: 86_400 });
  const template = repo.createPlan({ name: `Test PayGo Plan ${scopeRef}`, billingMode: "paygo", durationSeconds: 31_536_000, budgetLimits: [privatePlanBudgetLimit(policy, "subscription")], accessPointIds: repo.listAccessPointsVisibleToScope(visibleToScopeRef).map((accessPoint) => accessPoint.id) });
  return repo.createPlan({ planTemplateId: template.id, scopeRef, source: "paygo_test" });
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

export function jsonRequest(url: string, token: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { host: new URL(url).host, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function cookieHeaderFromSetCookies(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

export function setCookiesFromResponse(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? response.headers.get("set-cookie")?.split(/,\s*(?=friday_)/) ?? [];
}

export function providerForMetric(id: string, input: Partial<Provider> = {}): Provider {
  return {
    id,
    scopeRef: "global:",
    name: id,
    kind: "openai",
    status: "enabled",
    baseUrlResolver: "literal:https://api.openai.com/v1",
    credentialResolver: "api-key:",
    modelsResolver: "provider:path:/models",
    configJson: "{}",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input
  };
}

export function providerModelForMetric(providerId: string, providerModelName: string): ProviderModel {
  return {
    id: `${providerId}_${providerModelName}`,
    providerId,
    providerModelName,
    displayName: providerModelName,
    status: "enabled",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
