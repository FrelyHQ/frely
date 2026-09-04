export const APPLICATION_OPERATION_ID_PATTERN = /^friday\.application\.[a-z0-9.]+\.v1$/;

export const APPLICATION_OPERATION_PUBLIC_ERROR_CODES = [
  "invalid_operation_input",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "operation_cancelled",
  "internal_error",
] as const;

export const RESERVED_EXECUTION_CONTEXT_INPUT_FIELDS = [
  "actor",
  "principal",
  "trustedScope",
  "trustedScopes",
  "capabilities",
  "authorization",
  "requestId",
  "concurrencyKey",
] as const;

export type ApplicationOperationPublicErrorCode = typeof APPLICATION_OPERATION_PUBLIC_ERROR_CODES[number];
export type ApplicationOperationKind = "user-query" | "owner-query" | "command";
export type ApplicationOperationDispatchPolicy = "bounded-loader-only" | "canonical-owner-api-only" | "typed-handler";

export interface CanonicalOperationHandlerReference {
  readonly kind: "bounded-query-module" | "typed-command-handler";
  readonly owner: string;
  readonly key: string;
  readonly source: string;
  readonly exportName: string;
}

export interface ApplicationOperationContractReference {
  readonly contractId: string;
  readonly schemaId: string;
  readonly schemaVersion: 1;
  readonly schemaKind: "canonical-operation-contract";
  readonly validationOwner: string;
  readonly executionContextFields: "forbidden";
  readonly transportFields: "forbidden";
}

export interface ApplicationOperationDescriptor {
  readonly id: string;
  readonly inventoryId: string;
  readonly kind: ApplicationOperationKind;
  readonly audience: string;
  readonly contextOwner: string;
  readonly applicationOwner: CanonicalOperationHandlerReference;
  readonly input: ApplicationOperationContractReference;
  readonly output: ApplicationOperationContractReference;
  readonly capability: {
    readonly policy: string;
    readonly source: "execution-context";
    readonly trustedScopeSource: "execution-context-only";
  };
  readonly risk: "low" | "sensitive-read" | "consequential" | "high";
  readonly sensitivity: string;
  readonly idempotency: "idempotent-read" | "canonical-handler-owned";
  readonly concurrency: "parallel-bounded-read" | "canonical-handler-owned";
  readonly cancellation: "abort-signal-propagated";
  readonly transactionOwner: {
    readonly owner: string;
    readonly policy: string;
  };
  readonly audit: {
    readonly builder: string;
    readonly obligation: "canonical-handler-policy";
    readonly policy: string;
    readonly actorSource: "execution-context";
  };
  readonly publicErrors: {
    readonly mapping: "application-operation-error.v1";
    readonly codes: readonly ApplicationOperationPublicErrorCode[];
  };
  readonly result: {
    readonly bounded: true;
    readonly policy: string;
    readonly pagination: "none" | "cursor" | "offset-or-handler-bounded";
    readonly cache: "no-store" | "request-scoped-private" | "private-no-store" | "canonical-handler-policy";
  };
  readonly execution: {
    readonly dispatchPolicy: ApplicationOperationDispatchPolicy;
    readonly transportNeutral: true;
    readonly mcpProjection: "none";
    readonly canonicalExecutionOnly: true;
  };
}

export interface ApplicationOperationExclusion {
  readonly inventoryId: string;
  readonly classification: "workflow transport" | "binary" | "auth/webhook/health/protocol" | "explicit exclusion";
  readonly owner: string;
  readonly source: string;
  readonly route: string;
  readonly method: string;
  readonly reason: string;
  readonly genericDispatch: "forbidden";
  readonly mcpProjection: "none";
}

export interface OwnerOperationMetadata {
  readonly operationId: string;
  readonly inventoryId: string;
  readonly kind: "owner-query" | "command";
  readonly canonicalOperationId: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly handler: CanonicalOperationHandlerReference;
  readonly sensitivity: string;
  readonly pagination: "none" | "cursor" | "offset-or-handler-bounded";
  readonly bounds: string;
  readonly cache: "no-store" | "request-scoped-private" | "private-no-store" | "canonical-handler-policy";
  readonly mappingMode: "fixed-allowlisted-operation" | "existing-catch-all-adapter-envelope";
  readonly execution: "canonical-owner-api-only";
  readonly mcpProjection: "none";
}

export interface TrustedOperationActor {
  readonly kind: "user" | "api-key" | "system" | "anonymous";
  readonly id: string;
}

export interface TrustedOperationPrincipal {
  readonly kind: "user" | "api-key" | "anonymous";
  readonly id: string | null;
}

export interface ApplicationOperationExecutionContext {
  readonly actor: TrustedOperationActor;
  readonly principal: TrustedOperationPrincipal;
  readonly trustedScope: string | null;
  readonly capabilities: ReadonlySet<string>;
  readonly requestId: string;
  readonly concurrencyKey: string | null;
  readonly signal: AbortSignal;
}
