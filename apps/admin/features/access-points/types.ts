export interface AccessPointSummary {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  targetType: "provider-model" | "access-point";
  targetId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  priority: number;
  weight: number;
  fallbackOrder: number;
  status: string;
  routing?: {
    selector: {
      id: "direct" | "ordered-fallback";
      behaviorVersion: 1;
      config: { maxAttempts?: number; retryOn?: string[] };
    };
    requestOverrides?: Record<string, unknown>;
    targets: Array<{
      id: string;
      targetType: "provider-model" | "access-point";
      targetAccessPointId: string | null;
      targetProviderId: string | null;
      targetProviderModelName: string | null;
      position: number;
      status: "enabled" | "disabled";
    }>;
    routingRevision: number;
  };
  impact?: {
    plans: Array<{ id: string; name: string; version: number }>;
    activeOrFutureSubscriptionCount: number;
    exposedModels: string[];
  };
}
export interface ProviderSummary {
  id: string;
  name: string;
  kind: string;
  modelsResolver: string;
  status: string;
}
export interface ProviderModelSummary {
  id: string;
  providerId: string;
  providerModelName: string;
  displayName: string;
  status: string;
}
export interface TeamSummary {
  id: string;
  name: string;
  status: string;
}
export interface UserSummary {
  id: string;
  teamId: string | null;
  email: string;
  role: string;
  status: string;
}
export interface ApiKeySummary {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  status: string;
}
export interface AdminSession {
  userId: string;
  email: string;
}
export interface AccessPointPageData {
  accessPoints: AccessPointSummary[];
  currentUserScopeRef: string;
}
export interface ProviderModelCandidate {
  providerModelName: string;
  displayName: string;
}
export interface ProviderModelCandidateList {
  items: ProviderModelCandidate[];
  warning?: string;
}
