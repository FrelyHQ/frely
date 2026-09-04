import { isProviderCredentialFailureReason, RelayError, type ProviderCredentialFailureReason, type ProviderFailureClass, type ProviderFetchDiagnosticV1 } from "@frely/core";

export { isProviderCredentialFailureReason, PROVIDER_CREDENTIAL_FAILURE_REASONS } from "@frely/core";
export type { ProviderCredentialFailureReason } from "@frely/core";

export type ProviderRuntimeRequestKind = "chat.completions" | "responses" | "messages" | "embeddings" | "models";
export type ProviderRuntimeApiFormat = "openai" | "openai-responses" | "anthropic";
export type ProviderCostExposure = "not_started" | "accruing" | "stopped";
export type ProviderFinalUsageEvidence = "absent" | "pending" | "final";
export const CPA_BASIC_EVIDENCE_CONTRACT = "cpa-basic@1" as const;

export interface ProviderUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "provider" | "response";
}

/**
 * Normalized stock-CPA evidence. CPA, not Relay, produces this complete
 * envelope. Relay may validate and project it but may not derive any field
 * from HTTP status, Provider events, usage aliases, [DONE], EOF, or cancel.
 */
export interface CpaBasicEvidenceEnvelopeV1 {
  readonly contract: "cpa-basic@1";
  readonly version: 1;
  readonly providerAttemptRef: string;
  readonly costExposure: ProviderCostExposure;
  readonly finalUsageEvidence: ProviderFinalUsageEvidence;
  readonly failureClass?: ProviderFailureClass;
  readonly trustedUsage?: ProviderUsage;
  readonly serviceTier?: string;
}

export interface CpaBasicJsonEnvelopeV1 {
  readonly contract: "cpa-basic-json@1";
  readonly version: 1;
  readonly response: unknown;
  readonly evidence: CpaBasicEvidenceEnvelopeV1;
}

export interface CpaBasicStreamEvidenceEventV1 {
  readonly type: "cpa.basic.evidence";
  readonly envelope: CpaBasicEvidenceEnvelopeV1;
}

export interface ProviderAttemptFailureV1 {
  readonly version: 1;
  readonly failureClass: ProviderFailureClass;
  readonly failureReason?: ProviderCredentialFailureReason;
  readonly costExposure: ProviderCostExposure;
  readonly finalUsageEvidence: ProviderFinalUsageEvidence;
  readonly trustedUsage?: ProviderUsage;
}

export interface ProviderExecutionEvidenceV1 {
  readonly version: 1;
  readonly costExposure: ProviderCostExposure;
  readonly finalUsageEvidence: ProviderFinalUsageEvidence;
  readonly trustedUsage?: ProviderUsage;
}

export type ProviderPipelineInvocationSnapshot = Readonly<{
  schemaVersion: 1;
  planRevision: string;
  invocations: readonly Readonly<{
    pluginId: string;
    behaviorVersion: number;
    hook: string;
    instanceRevision: string;
    outcome: "applied" | "noop" | "denied" | "failed" | "fallback";
  }>[];
}>;

export type ProviderStreamTerminalV1 =
  | { outcome: "succeeded"; evidence: ProviderExecutionEvidenceV1; usage?: ProviderUsage; serviceTier?: string }
  | { outcome: "failed"; code: string; message: string; retryable: boolean; diagnostic?: ProviderFetchDiagnosticV1; failure: ProviderAttemptFailureV1 };

export type ProviderStreamEvent =
  | { type: "chunk"; data: unknown; terminal?: ProviderStreamTerminalV1 }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "error"; code: string; message: string; retryable: boolean; diagnostic?: ProviderFetchDiagnosticV1; failure?: ProviderAttemptFailureV1 }
  | { type: "done"; usage?: ProviderUsage; serviceTier?: string; evidence?: ProviderExecutionEvidenceV1 };

export interface ProviderRuntimeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  stream?: AsyncIterable<ProviderStreamEvent>;
  usage?: ProviderUsage;
  /** Provider-reported observation; Billing remains frozen at admission. */
  serviceTier?: string;
  pipelineInvocationSnapshot?: ProviderPipelineInvocationSnapshot;
  evidence: ProviderExecutionEvidenceV1;
  failure?: ProviderAttemptFailureV1;
}

export type ProviderRuntimeTargetExpectation = Readonly<{
  providerModelId: string;
  providerId: string;
  providerModelName: string;
  providerKind: string;
  cpaInstanceId: string;
  providerUpdatedAt: string;
  providerModelUpdatedAt: string;
  bindingRevision: number;
}>;

export type PrepareProviderInvocationInput = Readonly<{
  providerModelId: string;
  providerId: string;
  providerModelName: string;
  kind: ProviderRuntimeRequestKind;
  sourceFormat: ProviderRuntimeApiFormat;
  sourceModel: string;
  stream: boolean;
  serviceTier: string;
  options: Readonly<Record<string, unknown>>;
}>;

type PreparedProviderInvocationBase = Readonly<{
  target: ProviderRuntimeTargetExpectation;
  kind: ProviderRuntimeRequestKind;
  sourceFormat: ProviderRuntimeApiFormat;
  sourceModel: string;
  stream: boolean;
  serviceTier: string;
  options: Readonly<Record<string, unknown>>;
}>;

/** Stage 1 deliberately carries no token or output-bound claim. A protected
 * preparation may only contain facts returned by CPA for the exact payload CPA
 * will execute; Relay never calculates either variant. */
export type CpaPreparationEvidence = Readonly<{
  evidenceId: string;
  evidenceVersion: number;
  preparedPayloadId: string;
}>;

export type PreparedProviderInvocation =
  | (PreparedProviderInvocationBase & Readonly<{
      preparationStage: "stage1";
      cpaPreparation: null;
      tokenizer: null;
      effectiveMaxBillableOutputTokens: null;
    }>)
  | (PreparedProviderInvocationBase & Readonly<{
      preparationStage: "protected";
      cpaPreparation: CpaPreparationEvidence;
      tokenizer: Readonly<{
        tokenizerId: string;
        revision: number;
        inputTokens: number;
      }>;
      effectiveMaxBillableOutputTokens: number;
    }>);

/** CPA-side preparation and execution capability. This is not a Relay
 * tokenizer or Pipeline Plugin: the same CPA capability prepares and invokes
 * one opaque payload identity. */
export interface ProviderPreparationPort {
  readonly capability: Readonly<{
    authority: "cpa";
    kind: "provider-preparation";
    contractVersion: 1;
  }>;
  prepare(input: Readonly<{
    request: PrepareProviderInvocationInput;
    target: ProviderRuntimeTargetExpectation;
  }>): Promise<PreparedProviderInvocation>;
  invokePrepared(input: Readonly<{
    providerAttemptRef: string;
    prepared: Extract<PreparedProviderInvocation, { preparationStage: "protected" }>;
    target: ProviderDispatchHandle["target"];
    signal?: AbortSignal;
    gatewayContext?: unknown;
  }>): Promise<Readonly<{
    executedPreparedPayloadId: string;
    response: ProviderRuntimeResponse;
  }>>;
}

export type InvokeProviderAttemptInput = Readonly<{
  providerAttemptRef: string;
  dispatch: ProviderDispatchHandle;
  signal?: AbortSignal;
  /** Opaque Gateway-owned orchestration context. Provider Runtime only carries
   * it to the explicitly composed adapter and never persists or inspects it. */
  gatewayContext?: unknown;
}>;

export type ProviderDispatchHandle = Readonly<{
  prepared: PreparedProviderInvocation;
  target: ProviderRuntimeTargetExpectation & Readonly<{
    authMethod: "oauth" | "api-key" | "credential-import";
    credentialOwnership: "cpa-managed";
  }>;
}>;

export interface ProviderRuntime {
  /** Stage 1 uses the existing non-reserving ProviderAttempt/Billing path. */
  readonly preparationStage: PreparedProviderInvocation["preparationStage"];
  prepare(input: PrepareProviderInvocationInput): Promise<PreparedProviderInvocation>;
  refreshForDispatch(prepared: PreparedProviderInvocation): Promise<ProviderDispatchHandle>;
  invokeAdmittedCandidate(input: InvokeProviderAttemptInput): Promise<ProviderRuntimeResponse>;
}

export function cpaPreparationEvidenceUnavailable(): RelayError & {
  readonly costExposure: "not_started";
  readonly finalUsageEvidence: "absent";
} {
  return Object.assign(new RelayError(
    "cpa_preparation_evidence_unavailable",
    "CPA does not expose the required side-effect-free preparation evidence contract",
    503,
  ), {
    costExposure: "not_started" as const,
    finalUsageEvidence: "absent" as const,
  });
}

export function providerRuntimePreDispatchError(error: unknown): RelayError & {
  readonly costExposure: "not_started";
  readonly finalUsageEvidence: "absent";
} {
  const relay = error instanceof RelayError
    ? error
    : new RelayError("provider_runtime_pre_dispatch_failed", "Provider Runtime pre-dispatch validation failed", 503);
  return Object.assign(relay, {
    costExposure: "not_started" as const,
    finalUsageEvidence: "absent" as const,
  });
}

export function parseCpaBasicEvidenceEnvelope(
  value: unknown,
  expectedProviderAttemptRef: string,
): CpaBasicEvidenceEnvelopeV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => ![
    "contract", "version", "providerAttemptRef", "costExposure", "finalUsageEvidence",
    "failureClass", "trustedUsage", "serviceTier",
  ].includes(key))
    || record.contract !== "cpa-basic@1"
    || record.version !== 1
    || record.providerAttemptRef !== expectedProviderAttemptRef) return null;
  const costExposure = String(record.costExposure ?? "");
  const finalUsageEvidence = String(record.finalUsageEvidence ?? "");
  if (!isProviderCostExposure(costExposure) || !isProviderFinalUsageEvidence(finalUsageEvidence)) return null;
  const failureClass = record.failureClass;
  if (failureClass !== undefined && !isProviderFailureClass(failureClass)) return null;
  const trustedUsage = record.trustedUsage;
  if (trustedUsage !== undefined && !isTrustedProviderUsage(trustedUsage)) return null;
  const serviceTier = record.serviceTier;
  if (serviceTier !== undefined && (typeof serviceTier !== "string" || serviceTier.length < 1 || serviceTier.length > 64)) return null;
  if ((finalUsageEvidence === "final") !== Boolean(trustedUsage)
    || (costExposure === "not_started" && (finalUsageEvidence !== "absent" || trustedUsage !== undefined))
    || (costExposure === "stopped" && finalUsageEvidence === "absent")
    || (costExposure === "accruing" && finalUsageEvidence !== "pending")) return null;
  return Object.freeze({
    contract: "cpa-basic@1",
    version: 1,
    providerAttemptRef: expectedProviderAttemptRef,
    costExposure,
    finalUsageEvidence,
    ...(failureClass ? { failureClass } : {}),
    ...(trustedUsage ? { trustedUsage: Object.freeze({ ...trustedUsage }) } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  });
}

export function parseCpaBasicJsonEnvelope(
  value: unknown,
  expectedProviderAttemptRef: string,
): CpaBasicJsonEnvelopeV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["contract", "version", "response", "evidence"].includes(key))
    || record.contract !== "cpa-basic-json@1"
    || record.version !== 1
    || !("response" in record)) return null;
  const evidence = parseCpaBasicEvidenceEnvelope(record.evidence, expectedProviderAttemptRef);
  return evidence ? Object.freeze({ contract: "cpa-basic-json@1", version: 1, response: record.response, evidence }) : null;
}

export function parseCpaBasicStreamEvidenceEvent(
  value: unknown,
  expectedProviderAttemptRef: string,
): CpaBasicEvidenceEnvelopeV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["type", "envelope"].includes(key))
    || record.type !== "cpa.basic.evidence") return null;
  return parseCpaBasicEvidenceEnvelope(record.envelope, expectedProviderAttemptRef);
}

export function parseProviderAttemptFailure(value: unknown): ProviderAttemptFailureV1 | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return unresolvedProviderFailure();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["version", "failureClass", "failureReason", "costExposure", "finalUsageEvidence", "trustedUsage"].includes(key))
    || record.version !== 1
    || !["connect_error", "timeout", "rate_limited", "upstream_5xx", "non_retryable"].includes(String(record.failureClass))
    || (record.failureReason !== undefined && !isProviderCredentialFailureReason(record.failureReason))
  ) return unresolvedProviderFailure();
  const costExposure = String(record.costExposure ?? "accruing");
  const finalUsageEvidence = String(record.finalUsageEvidence ?? "pending");
  if (!["not_started", "accruing", "stopped"].includes(costExposure)
    || !["absent", "pending", "final"].includes(finalUsageEvidence)) return unresolvedProviderFailure();
  const trustedUsage = record.trustedUsage;
  if (trustedUsage !== undefined && !isTrustedProviderUsage(trustedUsage)) return unresolvedProviderFailure();
  if ((finalUsageEvidence === "final") !== Boolean(trustedUsage)
    || (costExposure === "not_started" && (finalUsageEvidence !== "absent" || trustedUsage !== undefined))
    || (costExposure === "stopped" && finalUsageEvidence === "absent")) return unresolvedProviderFailure();
  return Object.freeze({
    version: 1,
    failureClass: record.failureClass as ProviderFailureClass,
    ...(isProviderCredentialFailureReason(record.failureReason) ? { failureReason: record.failureReason } : {}),
    costExposure: costExposure as ProviderCostExposure,
    finalUsageEvidence: finalUsageEvidence as ProviderFinalUsageEvidence,
    ...(trustedUsage ? { trustedUsage } : {}),
  });
}

export function parseProviderExecutionEvidence(value: unknown): ProviderExecutionEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unresolvedProviderExecutionEvidence();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["version", "costExposure", "finalUsageEvidence", "trustedUsage"].includes(key))
    || record.version !== 1) return unresolvedProviderExecutionEvidence();
  const costExposure = String(record.costExposure ?? "accruing");
  const finalUsageEvidence = String(record.finalUsageEvidence ?? "pending");
  if (!["not_started", "accruing", "stopped"].includes(costExposure)
    || !["absent", "pending", "final"].includes(finalUsageEvidence)) return unresolvedProviderExecutionEvidence();
  const trustedUsage = record.trustedUsage;
  if (trustedUsage !== undefined && !isTrustedProviderUsage(trustedUsage)) return unresolvedProviderExecutionEvidence();
  if ((finalUsageEvidence === "final") !== Boolean(trustedUsage)
    || (costExposure === "not_started" && (finalUsageEvidence !== "absent" || trustedUsage !== undefined))
    || (costExposure === "stopped" && finalUsageEvidence === "absent")) return unresolvedProviderExecutionEvidence();
  return Object.freeze({
    version: 1,
    costExposure: costExposure as ProviderCostExposure,
    finalUsageEvidence: finalUsageEvidence as ProviderFinalUsageEvidence,
    ...(trustedUsage ? { trustedUsage } : {}),
  });
}

export function unresolvedProviderExecutionEvidence(): ProviderExecutionEvidenceV1 {
  return Object.freeze({ version: 1, costExposure: "accruing", finalUsageEvidence: "pending" });
}

export function unresolvedProviderFailure(failureClass: ProviderFailureClass = "non_retryable"): ProviderAttemptFailureV1 {
  return Object.freeze({ version: 1, failureClass, costExposure: "accruing", finalUsageEvidence: "pending" });
}

export function providerFailureFromResponse(response: Readonly<{ status: number; failure?: ProviderAttemptFailureV1 }>): ProviderAttemptFailureV1 {
  const declared = parseProviderAttemptFailure(response.failure);
  if (declared) return declared;
  return unresolvedProviderFailure(response.status === 429
    ? "rate_limited"
    : response.status >= 500
      ? "upstream_5xx"
      : "non_retryable");
}

export function providerFailureFromThrown(error: unknown): ProviderAttemptFailureV1 {
  const code = error instanceof RelayError ? error.code : error instanceof Error ? error.name : "";
  const status = error instanceof RelayError ? error.status : 0;
  const evidence = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  const retryableCredentialFailure = evidence?.failureReason === "auth_unavailable" || evidence?.failureReason === "model_cooldown";
  const retryableServerError = retryableCredentialFailure || /(?:^|_)(?:unavailable|upstream_5xx|stream_failed)(?:$|_)/i.test(code);
  const failureClass: ProviderFailureClass = status === 429
    ? "rate_limited"
    : /timeout/i.test(code)
      ? "timeout"
      : /fetch|connect|socket|network/i.test(code)
        ? "connect_error"
        : status >= 500 && retryableServerError
          ? "upstream_5xx"
          : "non_retryable";
  return parseProviderAttemptFailure({
    version: 1,
    failureClass,
    ...(isProviderCredentialFailureReason(code)
      ? { failureReason: code }
      : evidence?.failureReason === undefined ? {} : { failureReason: evidence.failureReason }),
    ...(evidence?.costExposure === undefined ? {} : { costExposure: evidence.costExposure }),
    ...(evidence?.finalUsageEvidence === undefined ? {} : { finalUsageEvidence: evidence.finalUsageEvidence }),
    ...(evidence?.trustedUsage === undefined ? {} : { trustedUsage: evidence.trustedUsage }),
  }) ?? unresolvedProviderFailure(failureClass);
}

export function failureClassFromProviderError(code: string, diagnostic?: ProviderFetchDiagnosticV1): ProviderFailureClass {
  if (/rate.?limit/i.test(code)) return "rate_limited";
  if (/timeout|lifetime|idle/i.test(code) || diagnostic?.causeCode === "TIMEOUT") return "timeout";
  if (/fetch|connect|socket|network/i.test(code)) return "connect_error";
  return diagnostic?.retryable ? "upstream_5xx" : "non_retryable";
}

export function isTrustedProviderUsage(value: unknown): value is ProviderUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return Object.keys(usage).every((key) => [
    "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "totalTokens", "source",
  ].includes(key))
    && (usage.source === "provider" || usage.source === "response")
    && ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "totalTokens"]
      .every((key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
    && (usage.cachedInputTokens as number) + (usage.cacheWriteTokens as number) <= (usage.inputTokens as number)
    && (usage.totalTokens as number) === (usage.inputTokens as number) + (usage.outputTokens as number);
}

function isProviderCostExposure(value: string): value is ProviderCostExposure {
  return value === "not_started" || value === "accruing" || value === "stopped";
}

function isProviderFinalUsageEvidence(value: string): value is ProviderFinalUsageEvidence {
  return value === "absent" || value === "pending" || value === "final";
}

function isProviderFailureClass(value: unknown): value is ProviderFailureClass {
  return value === "connect_error" || value === "timeout" || value === "rate_limited"
    || value === "upstream_5xx" || value === "non_retryable";
}
