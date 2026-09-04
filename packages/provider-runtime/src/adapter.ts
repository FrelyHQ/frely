import type {
  ProviderAttemptFailureV1,
  ProviderExecutionEvidenceV1,
  ProviderPipelineInvocationSnapshot,
  ProviderRuntimeApiFormat,
  ProviderRuntimeRequestKind,
  ProviderStreamEvent,
  ProviderUsage,
} from "./index.js";

/** Internal transport DTO. It never crosses the Provider Runtime root port. */
export interface ProviderAdapterRequest {
  kind: ProviderRuntimeRequestKind;
  provider: {
    id: string;
    cpaInstanceId: string;
    bindingRevision: number;
    authMethod: "oauth" | "api-key" | "credential-import";
    credentialOwnership: "cpa-managed";
    credentialRefCount: 1;
  };
  sourceFormat?: ProviderRuntimeApiFormat;
  sourceModel?: string;
  tarModel: string;
  stream: boolean;
  signal?: AbortSignal;
  options: Record<string, unknown>;
  metadata: {
    providerAttemptId: string;
    gatewayContext?: unknown;
  };
}

export interface ProviderAdapter {
  invoke(request: ProviderAdapterRequest): Promise<ProviderAdapterResponse>;
}

export interface ProviderAdapterResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  stream?: AsyncIterable<ProviderStreamEvent>;
  usage?: ProviderUsage;
  serviceTier?: string;
  pipelineInvocationSnapshot?: ProviderPipelineInvocationSnapshot;
  evidence?: ProviderExecutionEvidenceV1;
  failure?: ProviderAttemptFailureV1;
}
