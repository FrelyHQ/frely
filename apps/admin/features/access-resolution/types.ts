export interface ApiKeyOption { id: string; name: string; keyPrefix: string; status: string }
export interface AccessPointOption { id: string; name: string; description: string | null; ownerId: string; scopeRef: string; exposedModel: string; targetModel: string; status: string }
export interface ResolutionTrace {
  actor: { actorType: string; actorId: string };
  principal: { apiKeyId: string; userId: string; effectiveScopes: string[] };
  scopeRef: string;
  accessPoint: AccessPointOption;
  providerId: string;
  providerModelName: string;
  reqModel: string;
  tarModel: string;
  credentialRef: string;
  checkedScopeRefs: string[];
  matchedAccessPoints: AccessPointOption[];
  candidateAccessPoints: AccessPointOption[];
  candidateId: string;
  candidatePlan: {
    entryAccessPointId: string;
    selectorAccessPointId: string;
    selectorId: string;
    selectorBehaviorVersion: number;
    routingRevision: number;
    candidates: Array<{
      candidateId: string;
      selectorTargetEdgeId: string;
      pathTargetEdgeIds: string[];
      providerId: string;
      providerModelName: string;
      available: boolean;
      unavailableReason: string | null;
      accessPointChain: AccessPointOption[];
    }>;
  };
  resolutionPath: Array<{ scopeRef: string; ownerId: string; accessPointScopeRef: string; accessPointId: string; exposedModel: string; description: string | null; targetModel: string; targetType: string; targetId: string | null; targetProviderId: string | null; targetProviderModelName: string | null }>;
}
export interface PreviewInput { apiKeyId: string; accessPointId: string; reqModel: string }
