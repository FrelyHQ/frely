export * from "./provider-credentials.js";

import { RelayError } from "@frely/core";
import {
  providerFailureFromThrown,
  providerRuntimePreDispatchError,
  parseProviderExecutionEvidence,
  type PrepareProviderInvocationInput,
  type PreparedProviderInvocation,
  type ProviderPreparationPort,
  type ProviderRuntimeResponse,
  type ProviderRuntime,
  type ProviderDispatchHandle,
  type ProviderExecutionEvidenceV1,
} from "@frely/provider-runtime";
import type { ProviderAdapter, ProviderAdapterRequest, ProviderAdapterResponse } from "@frely/provider-runtime/adapter";
import type { ProviderRuntimeTargetMaterial, ProviderRuntimeTargetReader } from "@frely/provider-runtime/server";
import { CliProxyClient, type CliProxyClientOptions } from "./cliproxy/client.js";
import { loadCliProxyConfig } from "./cliproxy/config.js";
import { cpaConnectionEntry, createCpaInferenceClient, loadCpaConnectionRegistry, type CpaConnectionRegistry } from "./cliproxy/connection-registry.js";
import { CliProxyTransport, type CliProxyTransportOptions } from "./cliproxy/transport.js";

export * from "./cliproxy/client.js";
export * from "./cliproxy/config.js";
export * from "./cliproxy/connection-registry.js";
export * from "./cliproxy/control-client.js";
export * from "./cliproxy/catalog.js";
export * from "./cliproxy/errors.js";
export * from "./cliproxy/provider-id.js";
export * from "./cliproxy/provider-kinds.js";
export * from "./cliproxy/sse.js";
export * from "./cliproxy/transport.js";
export * from "./management/cliproxy-binding-control.js";
export * from "./management/async-application-service.js";
export * from "./management/provider-id.js";

/**
 * Production provider composition. Every Provider request is routed through
 * the fixed internal CLIProxyAPI transport.
 */
export class DefaultProviderAdapter implements ProviderAdapter {
  readonly #defaultCliProxyTransport: CliProxyTransport;
  readonly #cliProxyTransports = new Map<string, CliProxyTransport>();
  readonly #connectionRegistry: CpaConnectionRegistry | null;
  readonly #cliProxyClientOptions: CliProxyClientOptions | undefined;
  readonly #cliProxyTransportOptions: CliProxyTransportOptions | undefined;

  constructor(options: {
    cliProxyTransport?: CliProxyTransport;
    cliProxyClientOptions?: CliProxyClientOptions;
    cliProxyTransportOptions?: CliProxyTransportOptions;
    cpaConnectionRegistry?: CpaConnectionRegistry | null;
  } = {}) {
    this.#connectionRegistry = options.cpaConnectionRegistry === undefined ? loadCpaConnectionRegistry() : options.cpaConnectionRegistry;
    this.#cliProxyClientOptions = options.cliProxyClientOptions;
    this.#cliProxyTransportOptions = options.cliProxyTransportOptions;
    this.#defaultCliProxyTransport = options.cliProxyTransport ?? new CliProxyTransport(
      new CliProxyClient(loadCliProxyConfig(), options.cliProxyClientOptions),
      options.cliProxyTransportOptions
    );
  }

  invoke(request: ProviderAdapterRequest): Promise<ProviderAdapterResponse> {
    return this.transportFor(request).invoke(request);
  }

  private transportFor(request: ProviderAdapterRequest): CliProxyTransport {
    const instanceId = request.provider.cpaInstanceId;
    if (instanceId === "cpa_default" && !this.#connectionRegistry) return this.#defaultCliProxyTransport;
    if (!this.#connectionRegistry) throw new RelayError("cpa_instance_connection_missing", "CPA Instance connection is not configured", 503);
    const existing = this.#cliProxyTransports.get(instanceId);
    if (existing) return existing;
    cpaConnectionEntry(this.#connectionRegistry, instanceId);
    const transport = new CliProxyTransport(
      createCpaInferenceClient(this.#connectionRegistry, instanceId, this.#cliProxyClientOptions ? { clientOptions: this.#cliProxyClientOptions } : {}),
      this.#cliProxyTransportOptions ?? {}
    );
    this.#cliProxyTransports.set(instanceId, transport);
    return transport;
  }
}

/** Stateless Provider Runtime coordinator for one already selected candidate. */
export class DefaultProviderRuntime implements ProviderRuntime {
  readonly preparationStage: PreparedProviderInvocation["preparationStage"];

  constructor(
    private readonly targets: ProviderRuntimeTargetReader,
    private readonly adapter: ProviderAdapter = new DefaultProviderAdapter(),
    private readonly preparations?: ProviderPreparationPort,
  ) {
    if (preparations && (preparations.capability.authority !== "cpa"
      || preparations.capability.kind !== "provider-preparation"
      || preparations.capability.contractVersion !== 1)) {
      throw new Error("cpa_preparation_capability_invalid");
    }
    this.preparationStage = preparations ? "protected" : "stage1";
  }

  async prepare(input: PrepareProviderInvocationInput): Promise<PreparedProviderInvocation> {
    const target = await this.loadExpectedTarget(input.providerModelId, {
      providerId: input.providerId,
      providerModelName: input.providerModelName,
    });
    const expectedTarget = targetExpectation(target);
    if (this.preparations) {
      const prepared = await this.preparations.prepare({ request: input, target: expectedTarget });
      return validateCpaPreparedInvocation(prepared, input, expectedTarget);
    }
    return Object.freeze({
      target: expectedTarget,
      kind: input.kind,
      sourceFormat: input.sourceFormat,
      sourceModel: input.sourceModel,
      stream: input.stream,
      serviceTier: input.serviceTier,
      options: Object.freeze({ ...input.options }),
      preparationStage: "stage1",
      cpaPreparation: null,
      tokenizer: null,
      effectiveMaxBillableOutputTokens: null,
    });
  }

  async refreshForDispatch(prepared: PreparedProviderInvocation): Promise<ProviderDispatchHandle> {
    try {
      const target = await this.loadExpectedTarget(prepared.target.providerModelId, prepared.target);
      return Object.freeze({ prepared, target: Object.freeze({ ...target }) });
    } catch (error) {
      throw providerRuntimePreDispatchError(error);
    }
  }

  async invokeAdmittedCandidate(input: Parameters<ProviderRuntime["invokeAdmittedCandidate"]>[0]): Promise<ProviderRuntimeResponse> {
    const { prepared, target } = input.dispatch;
    if (prepared.preparationStage === "protected") {
      if (!this.preparations) throw cpaPreparedInvocationUnavailable();
      try {
        const executed = await this.preparations.invokePrepared({
          providerAttemptRef: input.providerAttemptRef,
          prepared,
          target,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.gatewayContext === undefined ? {} : { gatewayContext: input.gatewayContext }),
        });
        if (executed.executedPreparedPayloadId !== prepared.cpaPreparation.preparedPayloadId) {
          throw cpaPreparedPayloadBindingMismatch();
        }
        return { ...executed.response, evidence: parseProviderExecutionEvidence(executed.response.evidence) };
      } catch (error) {
        const failure = providerFailureFromThrown(error);
        const relay = error instanceof RelayError ? error : null;
        return {
          status: relay?.status ?? 502,
          failure,
          evidence: {
            version: 1,
            costExposure: failure.costExposure,
            finalUsageEvidence: failure.finalUsageEvidence,
            ...(failure.trustedUsage ? { trustedUsage: failure.trustedUsage } : {}),
          },
          body: { error: { code: relay?.code ?? "cpa_prepared_invocation_failed", message: relay?.message ?? "CPA prepared invocation failed" } },
        };
      }
    }
    const request: ProviderAdapterRequest = {
      kind: prepared.kind,
      provider: {
        id: target.providerId,
        cpaInstanceId: target.cpaInstanceId,
        bindingRevision: target.bindingRevision,
        authMethod: target.authMethod,
        credentialOwnership: target.credentialOwnership,
        credentialRefCount: 1,
      },
      sourceFormat: prepared.sourceFormat,
      sourceModel: prepared.sourceModel,
      tarModel: target.providerModelName,
      stream: prepared.stream,
      ...(input.signal ? { signal: input.signal } : {}),
      options: { ...prepared.options },
      metadata: {
        providerAttemptId: input.providerAttemptRef,
        ...(input.gatewayContext === undefined ? {} : { gatewayContext: input.gatewayContext }),
      },
    };
    let response: ProviderAdapterResponse;
    try {
      response = await this.adapter.invoke(request);
    } catch (error) {
      const failure = providerFailureFromThrown(error);
      const relay = error instanceof RelayError ? error : null;
      response = {
        status: relay?.status ?? 502,
        failure,
        body: { error: { code: relay?.code ?? "provider_runtime_failed", message: relay?.message ?? "Provider Runtime failed" } },
      };
    }
    return { ...response, evidence: providerResponseEvidence(response) };
  }

  private async loadExpectedTarget(
    providerModelId: string,
    expected: Readonly<{ providerId: string; providerModelName: string; providerKind?: string; cpaInstanceId?: string; providerUpdatedAt?: string; providerModelUpdatedAt?: string; bindingRevision?: number }>,
  ): Promise<ProviderRuntimeTargetMaterial> {
    const target = await this.targets.loadAvailableTarget(providerModelId);
    if (target.providerId !== expected.providerId
      || target.providerModelName !== expected.providerModelName
      || (expected.providerKind !== undefined && target.providerKind !== expected.providerKind)
      || (expected.cpaInstanceId !== undefined && target.cpaInstanceId !== expected.cpaInstanceId)
      || (expected.providerUpdatedAt !== undefined && target.providerUpdatedAt !== expected.providerUpdatedAt)
      || (expected.providerModelUpdatedAt !== undefined && target.providerModelUpdatedAt !== expected.providerModelUpdatedAt)
      || (expected.bindingRevision !== undefined && target.bindingRevision !== expected.bindingRevision)) {
      throw new RelayError("provider_runtime_target_changed", "Provider Runtime target changed before dispatch", 409);
    }
    return target;
  }
}

function validateCpaPreparedInvocation(
  prepared: PreparedProviderInvocation,
  request: PrepareProviderInvocationInput,
  expectedTarget: PreparedProviderInvocation["target"],
): Extract<PreparedProviderInvocation, { preparationStage: "protected" }> {
  const identity = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 256;
  if (prepared.preparationStage !== "protected"
    || prepared.kind !== request.kind
    || prepared.sourceFormat !== request.sourceFormat
    || prepared.sourceModel !== request.sourceModel
    || prepared.stream !== request.stream
    || prepared.serviceTier !== request.serviceTier
    || !sameTargetExpectation(prepared.target, expectedTarget)
    || !prepared.options || typeof prepared.options !== "object" || Array.isArray(prepared.options)
    || !identity(prepared.cpaPreparation?.evidenceId)
    || !Number.isSafeInteger(prepared.cpaPreparation?.evidenceVersion) || prepared.cpaPreparation.evidenceVersion < 1
    || !identity(prepared.cpaPreparation?.preparedPayloadId)
    || !identity(prepared.tokenizer?.tokenizerId)
    || !Number.isSafeInteger(prepared.tokenizer?.revision) || prepared.tokenizer.revision < 1
    || !Number.isSafeInteger(prepared.tokenizer?.inputTokens) || prepared.tokenizer.inputTokens < 0
    || !Number.isSafeInteger(prepared.effectiveMaxBillableOutputTokens) || prepared.effectiveMaxBillableOutputTokens < 1) {
    throw new RelayError("cpa_preparation_evidence_invalid", "CPA preparation evidence is incomplete or invalid", 503);
  }
  return Object.freeze({
    ...prepared,
    target: Object.freeze({ ...prepared.target }),
    options: Object.freeze({ ...prepared.options }),
    cpaPreparation: Object.freeze({ ...prepared.cpaPreparation }),
    tokenizer: Object.freeze({ ...prepared.tokenizer }),
  });
}

function sameTargetExpectation(
  left: PreparedProviderInvocation["target"],
  right: PreparedProviderInvocation["target"],
): boolean {
  return left.providerModelId === right.providerModelId
    && left.providerId === right.providerId
    && left.providerModelName === right.providerModelName
    && left.providerKind === right.providerKind
    && left.cpaInstanceId === right.cpaInstanceId
    && left.providerUpdatedAt === right.providerUpdatedAt
    && left.providerModelUpdatedAt === right.providerModelUpdatedAt
    && left.bindingRevision === right.bindingRevision;
}

function cpaPreparedInvocationUnavailable(): RelayError & { costExposure: "not_started"; finalUsageEvidence: "absent" } {
  return Object.assign(new RelayError("cpa_preparation_capability_unavailable", "CPA preparation capability is unavailable", 503), {
    costExposure: "not_started" as const,
    finalUsageEvidence: "absent" as const,
  });
}

function cpaPreparedPayloadBindingMismatch(): RelayError & { costExposure: "accruing"; finalUsageEvidence: "pending" } {
  return Object.assign(new RelayError("cpa_prepared_payload_binding_mismatch", "CPA did not execute the admitted prepared payload identity", 502), {
    costExposure: "accruing" as const,
    finalUsageEvidence: "pending" as const,
  });
}

function providerResponseEvidence(response: ProviderAdapterResponse): ProviderExecutionEvidenceV1 {
  return parseProviderExecutionEvidence(response.evidence);
}

function targetExpectation(target: ProviderRuntimeTargetMaterial): PreparedProviderInvocation["target"] {
  return Object.freeze({
    providerModelId: target.providerModelId,
    providerId: target.providerId,
    providerModelName: target.providerModelName,
    providerKind: target.providerKind,
    cpaInstanceId: target.cpaInstanceId,
    providerUpdatedAt: target.providerUpdatedAt,
    providerModelUpdatedAt: target.providerModelUpdatedAt,
    bindingRevision: target.bindingRevision,
  });
}
