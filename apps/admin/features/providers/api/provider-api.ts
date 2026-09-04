import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { AuthMode } from "../form/provider-form-fields";
import type { ProviderOAuthStatusResult } from "../lib/oauth-status-polling";
import type { AdminSession, ApiKeyCandidate, ProviderDialogData, ProviderSummary, TeamSummary, UserCandidate } from "../types";

export async function fetchProviderDialogData(signal?: AbortSignal): Promise<ProviderDialogData> {
  const [teams, session] = await Promise.all([
    fetchList<TeamSummary>("/api/owner/teams", signal),
    fetchJson<AdminSession>("/api/owner/me", signal)
  ]);
  return { teams, session };
}

export async function fetchProviderUserCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  return fetchJson<{ items: UserCandidate[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/owner/user-candidates?${params}`, signal);
}

export async function fetchProviderApiKeyCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  return fetchJson<{ items: ApiKeyCandidate[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/owner/api-key-candidates?${params}`, signal);
}

export async function createProvider(input: object): Promise<ProviderSummary> {
  return mutateJson<ProviderSummary>("/api/owner/providers", "POST", input, "Create provider failed");
}

export async function updateProvider(input: object) {
  return mutateJson("/api/owner/providers", "PATCH", input, "Update provider failed");
}

export async function deleteProvider(providerId: string) {
  return mutateJson("/api/owner/providers", "DELETE", { id: providerId }, "Delete provider failed");
}

export async function saveProviderCredential(providerId: string, type: AuthMode, payload: Record<string, unknown>) {
  return mutateJson(`/api/owner/providers/${encodeURIComponent(providerId)}/credential`, "POST", { type, payload }, "Save provider credential failed");
}

export async function importProviderCredential(providerId: string, file: File, location: string) {
  const form = new FormData();
  form.set("file", file);
  form.set("location", location);
  const response = await fetch(`/api/owner/providers/${encodeURIComponent(providerId)}/credential-import`, { method: "POST", body: form });
  return readConsoleApiResponse<unknown>(response, "Import provider credential failed");
}

export async function clearProviderCredential(providerId: string) {
  const response = await fetch(`/api/owner/providers/${encodeURIComponent(providerId)}/credential`, { method: "DELETE" });
  return readConsoleApiResponse<unknown>(response, "Clear provider credential failed");
}

export async function syncProviderModels(providerId: string) {
  const response = await fetch(`/api/owner/providers/${encodeURIComponent(providerId)}/sync-models`, { method: "POST" });
  return readConsoleApiResponse<unknown>(response, "Sync provider models failed");
}

export async function updateProviderModel(input: { providerId: string; providerModelName: string; status: "enabled" | "disabled" }) {
  return mutateJson("/api/owner/provider-models", "PATCH", input, "Update provider model failed");
}

export async function reconcileProviderBinding(providerId: string) {
  const response = await fetch(`/api/owner/providers/${encodeURIComponent(providerId)}/reconcile`, { method: "POST" });
  return readConsoleApiResponse<unknown>(response, "Retry Provider binding failed");
}

export async function reconcileVisibleProviderBindings(items: Array<{ providerId: string; expectedRevision: number }>) {
  const results: Array<{ providerId: string; result: string }> = [];
  for (let index = 0; index < items.length; index += 50) {
    const response = await mutateJson<{ items: Array<{ providerId: string; result: string }> }>(
      "/api/owner/providers/reconcile-status",
      "POST",
      { items: items.slice(index, index + 50) },
      "Refresh Provider bindings failed",
    );
    results.push(...response.items);
  }
  return { items: results };
}

export async function startProviderOAuth(providerId: string) {
  return mutateJson(`/api/owner/providers/${encodeURIComponent(providerId)}/oauth/start`, "POST", {}, "Start Provider OAuth failed") as Promise<{ sessionId: string; authorizationUrl: string; expiresAt: string; bindingRevision: number }>;
}

export async function submitProviderOAuthCallback(providerId: string, sessionId: string, callbackUrl: string) {
  return mutateJson(`/api/owner/providers/${encodeURIComponent(providerId)}/oauth/callback`, "POST", { sessionId, callbackUrl }, "Submit Provider OAuth callback failed");
}

export async function fetchProviderOAuthStatus(providerId: string, sessionId: string, bindingRevision: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ sessionId, bindingRevision: String(bindingRevision) });
  return fetchJson<ProviderOAuthStatusResult>(`/api/owner/providers/${encodeURIComponent(providerId)}/oauth/status?${params}`, signal);
}

async function fetchList<T>(url: string, signal?: AbortSignal): Promise<T[]> {
  const result = await fetchJson<{ items?: T[] }>(url, signal);
  return result.items ?? [];
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : undefined);
  return readConsoleApiResponse<T>(response, `Failed to load ${url}`);
}

async function mutateJson<T = unknown>(url: string, method: "POST" | "PATCH" | "DELETE", input: object, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return readConsoleApiResponse<T>(response, fallbackMessage);
}
