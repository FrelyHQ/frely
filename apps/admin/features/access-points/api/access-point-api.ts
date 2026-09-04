import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { AccessPointSummary, ProviderModelCandidateList } from "../types";
export interface AccessPointCandidate { id: string; name: string; description: string | null; scopeRef: string; exposedModel: string; status: string; }
export interface AccessPointCandidatePage { items: AccessPointCandidate[]; page: number; pageSize: number; total: number; totalPages: number; }
export interface ProviderCandidate { id: string; name: string; kind: string; status: string; }
export interface TeamCandidate { id: string; name: string; status: string; }
export interface UserCandidate { id: string; email: string; status: string; }
export interface ApiKeyCandidate { id: string; userId: string; name: string; keyPrefix: string; status: string; }
interface CandidatePage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number; }
export interface ScopeCandidatePage {
  teams: TeamCandidate[];
  users: UserCandidate[];
  apiKeys: ApiKeyCandidate[];
  page: number;
  totalPages: number;
}

export async function fetchAccessPointCandidates(query: string, page: number, signal?: AbortSignal): Promise<AccessPointCandidatePage> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/access-point-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<AccessPointCandidatePage>(response, "Load AccessPoint candidates failed");
}
export async function fetchProviderCandidates(query: string, page: number, signal?: AbortSignal): Promise<{ items: ProviderCandidate[]; page: number; pageSize: number; total: number; totalPages: number }> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/provider-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse(response, "Load Provider candidates failed");
}
export async function fetchScopeCandidates(query: string, page: number, signal?: AbortSignal): Promise<ScopeCandidatePage> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const [teams, users, apiKeys] = await Promise.all([
    fetch(`/api/owner/team-candidates?${params}`, signal ? { signal } : undefined),
    fetch(`/api/owner/user-candidates?${params}`, signal ? { signal } : undefined),
    fetch(`/api/owner/api-key-candidates?${params}`, signal ? { signal } : undefined),
  ]);
  const [teamPage, userPage, apiKeyPage] = await Promise.all([
    readConsoleApiResponse<CandidatePage<TeamCandidate>>(teams, "Load Team candidates failed"),
    readConsoleApiResponse<CandidatePage<UserCandidate>>(users, "Load User candidates failed"),
    readConsoleApiResponse<CandidatePage<ApiKeyCandidate>>(apiKeys, "Load API key candidates failed"),
  ]);
  return {
    teams: teamPage.items,
    users: userPage.items,
    apiKeys: apiKeyPage.items,
    page,
    totalPages: Math.max(teamPage.totalPages, userPage.totalPages, apiKeyPage.totalPages),
  };
}
export async function fetchAccessPointImpact(id: string, signal?: AbortSignal): Promise<NonNullable<AccessPointSummary["impact"]>> {
  const response = await fetch(`/api/owner/access-points/${encodeURIComponent(id)}/impact`, signal ? { signal } : undefined);
  return readConsoleApiResponse(response, "Load AccessPoint impact failed");
}
export async function createAccessPoint(input: object, idempotencyKey: string) {
  return mutate("POST", input, "Create AccessPoint failed", idempotencyKey);
}
export async function updateAccessPoint(input: object) {
  return mutate("PATCH", input, "Update AccessPoint failed");
}
export async function deleteAccessPoint(id: string) {
  return mutate("DELETE", { id }, "Delete AccessPoint failed");
}
export async function fetchProviderModelCandidates(
  providerId: string,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/owner/providers/${encodeURIComponent(providerId)}/model-candidates`,
    signal ? { signal } : undefined,
  );
  return readConsoleApiResponse<ProviderModelCandidateList>(
    response,
    "Load provider model candidates failed",
  );
}
export async function patchAccessPoint(
  row: AccessPointSummary,
  patch: Partial<AccessPointSummary>,
) {
  return updateAccessPoint({
    id: row.id,
    scopeRef: patch.scopeRef ?? row.scopeRef,
    name: row.name,
    description: patch.description === undefined ? row.description : patch.description,
    apiFamily: row.apiFamily,
    exposedModel: row.exposedModel,
    targetModel: row.targetModel,
    ...(row.routing ? {
      routing: {
        selector: row.routing.selector,
        requestOverrides: row.routing.requestOverrides ?? {},
        targets: row.routing.targets.map((target) => ({
          id: target.id,
          type: target.targetType,
          targetAccessPointId: target.targetAccessPointId,
          targetProviderId: target.targetProviderId,
          targetProviderModelName: target.targetProviderModelName,
          position: target.position,
          status: target.status,
        })),
        routingRevision: row.routing.routingRevision,
      },
    } : {
      targetType: row.targetType,
      targetId: row.targetId,
      targetProviderId: row.targetProviderId,
      targetProviderModelName: row.targetProviderModelName,
    }),
    priority: patch.priority ?? row.priority,
    weight: patch.weight ?? row.weight,
    fallbackOrder: patch.fallbackOrder ?? row.fallbackOrder,
    status: patch.status ?? row.status,
  });
}
async function mutate(
  method: "POST" | "PATCH" | "DELETE",
  input: object,
  message: string,
  idempotencyKey?: string,
) {
  const response = await fetch("/api/owner/access-points", {
    method,
    headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(input),
  });
  return readConsoleApiResponse<unknown>(response, message);
}
