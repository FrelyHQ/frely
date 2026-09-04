import { readConsoleApiResponse } from "@frely/console-ui/api-error";

async function teamProviderRequest<T>(
  teamId: string,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, unknown>
) {
  const response = await fetch(`/api/team/providers${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId, ...(body ?? {}) })
  });
  return readConsoleApiResponse<T>(response, "Team Provider operation failed");
}

export function createTeamProvider(teamId: string, input: {
  name: string;
  kind: string;
  authMethod: "api-key" | "oauth";
  baseUrl?: string;
  model?: string;
}) {
  return teamProviderRequest<{ id: string }>(teamId, "", "POST", {
    name: input.name,
    kind: input.kind,
    authMethod: input.authMethod,
    config: input.authMethod === "api-key"
      ? { baseUrl: input.baseUrl, models: [{ name: input.model, alias: input.model }] }
      : {}
  });
}

export function saveTeamProviderCredential(teamId: string, providerId: string, apiKey: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}/credential`, "POST", { type: "api-key", payload: { apiKey } });
}

export function syncTeamProviderModels(teamId: string, providerId: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}/models/sync`, "POST");
}

export function updateTeamProviderModel(teamId: string, providerId: string, providerModelName: string, status: "enabled" | "disabled") {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}/models/${encodeURIComponent(providerModelName)}`, "PATCH", { status });
}

export async function reconcileVisibleTeamProviderBindings(teamId: string, items: Array<{ providerId: string; expectedRevision: number }>) {
  const results: Array<{ providerId: string; result: string }> = [];
  for (let index = 0; index < items.length; index += 50) {
    const response = await teamProviderRequest<{ items: Array<{ providerId: string; result: string }> }>(
      teamId, "/reconcile-status", "POST", { items: items.slice(index, index + 50) },
    );
    results.push(...response.items);
  }
  return { items: results };
}

export function disableTeamProvider(teamId: string, providerId: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}`, "PATCH", { status: "disabled" });
}

export function enableTeamProvider(teamId: string, providerId: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}`, "PATCH", { status: "enabled" });
}

export function appendTeamProviderModelCost(teamId: string, input: {
  providerId: string;
  providerModelName: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(input.providerId)}/model-costs`, "POST", input);
}

export function startTeamProviderOAuth(teamId: string, providerId: string) {
  return teamProviderRequest<{ sessionId: string; authorizationUrl: string; expiresAt: string; bindingRevision: number }>(
    teamId, `/${encodeURIComponent(providerId)}/oauth/start`, "POST"
  );
}

export function submitTeamProviderOAuthCallback(teamId: string, providerId: string, sessionId: string, callbackUrl: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}/oauth/callback`, "POST", { sessionId, callbackUrl });
}

export async function fetchTeamProviderOAuthStatus(teamId: string, providerId: string, sessionId: string, bindingRevision: number) {
  const params = new URLSearchParams({ teamId, sessionId, bindingRevision: String(bindingRevision) });
  const response = await fetch(`/api/team/providers/${encodeURIComponent(providerId)}/oauth/status?${params}`);
  return readConsoleApiResponse<{ status: string; errorCode?: string | null }>(response, "Team Provider OAuth status could not be loaded");
}

export function clearTeamProviderCredential(teamId: string, providerId: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}/credential/clear`, "POST");
}

export function retireTeamProvider(teamId: string, providerId: string) {
  return teamProviderRequest(teamId, `/${encodeURIComponent(providerId)}`, "DELETE");
}
