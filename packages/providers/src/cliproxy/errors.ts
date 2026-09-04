import { providerFetchCauseCode, RelayError, type ProviderFetchDiagnosticV1 } from "@frely/core";
import type { ProviderAttemptFailureV1, ProviderCredentialFailureReason } from "@frely/provider-runtime";

export type CliProxyErrorStage = "configuration" | "request" | "response_headers" | "stream_read" | "protocol";

export class CliProxyError extends RelayError {
  readonly retryable: boolean;
  readonly stage: CliProxyErrorStage;
  readonly diagnostic?: ProviderFetchDiagnosticV1;
  readonly costExposure: NonNullable<ProviderAttemptFailureV1["costExposure"]>;
  readonly finalUsageEvidence: NonNullable<ProviderAttemptFailureV1["finalUsageEvidence"]>;
  readonly failureReason?: ProviderCredentialFailureReason;

  constructor(
    code: string,
    message: string,
    status: number,
    options: {
      retryable?: boolean;
      stage?: CliProxyErrorStage;
      diagnostic?: ProviderFetchDiagnosticV1;
      costExposure?: NonNullable<ProviderAttemptFailureV1["costExposure"]>;
      finalUsageEvidence?: NonNullable<ProviderAttemptFailureV1["finalUsageEvidence"]>;
      failureReason?: ProviderCredentialFailureReason;
      details?: Readonly<Record<string, unknown>>;
    } = {}
  ) {
    super(code, message, status, options.details);
    this.retryable = options.retryable ?? false;
    this.stage = options.stage ?? "request";
    // A response header or malformed stream does not prove that CPA/provider
    // generation has stopped. Only call sites holding terminal evidence may
    // explicitly classify an error as stopped.
    this.costExposure = options.costExposure ?? (this.stage === "configuration" ? "not_started" : "accruing");
    this.finalUsageEvidence = options.finalUsageEvidence ?? (this.costExposure === "not_started" ? "absent" : "pending");
    if (options.failureReason) this.failureReason = options.failureReason;
    if (options.diagnostic) this.diagnostic = options.diagnostic;
  }
}

export function cliProxyConfigurationError(message = "CLIProxyAPI configuration is invalid"): CliProxyError {
  return new CliProxyError("cliproxy_configuration_error", message, 503, { stage: "configuration" });
}

export function cliProxyProtocolError(message = "CLIProxyAPI returned an invalid response"): CliProxyError {
  return new CliProxyError("cliproxy_protocol_error", message, 502, {
    retryable: false,
    stage: "protocol",
    diagnostic: cliProxyDiagnostic("stream_read", false, 0, "CLIPROXY_PROTOCOL_ERROR")
  });
}

export function cliProxyHttpError(status: number, body: unknown): CliProxyError {
  const { code: upstreamCode, type: upstreamType } = safeUpstreamError(body);
  const details = {
    upstreamStatus: status,
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(upstreamType ? { upstreamType } : {})
  };
  const credentialFailure = cliProxyCredentialFailure(upstreamCode);
  if (credentialFailure) {
    return new CliProxyError(credentialFailure.publicCode, credentialFailure.message, 502, {
      retryable: credentialFailure.retryable,
      stage: "response_headers",
      failureReason: credentialFailure.failureReason,
      details,
      diagnostic: cliProxyDiagnostic("response_headers", credentialFailure.retryable, 0, credentialFailure.failureReason)
    });
  }
  if (status === 401 || upstreamType === "authentication_error") {
    return new CliProxyError("cliproxy_authentication_failed", "CLIProxyAPI rejected the service credential", 502, {
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", false, 0, upstreamCode)
    });
  }
  if (status === 403 || upstreamType === "permission_error") {
    return new CliProxyError("cliproxy_access_denied", "CLIProxyAPI denied the provider request", 502, {
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", false, 0, upstreamCode)
    });
  }
  if (status === 429 || upstreamType === "rate_limit_error") {
    return new CliProxyError("cliproxy_rate_limited", "CLIProxyAPI provider capacity is temporarily unavailable", 429, {
      retryable: true,
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", true, 0, upstreamCode)
    });
  }
  const requestError = cliProxyRequestError(status, upstreamType);
  if (requestError) {
    return new CliProxyError(requestError.code, requestError.message, requestError.status, {
      retryable: false,
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", false, 0, upstreamCode)
    });
  }
  if (status === 502 && upstreamCode && isRetryableUpstreamCode(upstreamCode)) {
    return new CliProxyError("cliproxy_unavailable", "CLIProxyAPI provider capacity is temporarily unavailable", 502, {
      retryable: true,
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", true, 0, upstreamCode)
    });
  }
  if (status === 502 && upstreamCode) {
    return new CliProxyError("cliproxy_provider_error", "CLIProxyAPI rejected the provider request", 502, {
      retryable: false,
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", false, 0, upstreamCode)
    });
  }
  if (status >= 500) {
    return new CliProxyError("cliproxy_unavailable", "CLIProxyAPI is temporarily unavailable", 502, {
      retryable: true,
      stage: "response_headers",
      details,
      diagnostic: cliProxyDiagnostic("response_headers", true, 0, upstreamCode)
    });
  }
  return new CliProxyError("cliproxy_provider_error", "CLIProxyAPI rejected the provider request", 502, {
    retryable: false,
    stage: "response_headers",
    details,
    diagnostic: cliProxyDiagnostic("response_headers", false, 0, upstreamCode)
  });
}

function cliProxyCredentialFailure(code: string | undefined): {
  publicCode: string;
  failureReason: ProviderCredentialFailureReason;
  message: string;
  retryable: boolean;
} | null {
  if (code === "auth_unauthorized") return {
    publicCode: "cliproxy_provider_credentials_unauthorized",
    failureReason: code,
    message: "CLIProxyAPI provider credential is unauthorized",
    retryable: false,
  };
  if (code === "auth_unavailable") return {
    publicCode: "cliproxy_provider_credentials_unavailable",
    failureReason: code,
    message: "CLIProxyAPI provider credential is temporarily unavailable",
    retryable: true,
  };
  if (code === "auth_not_found") return {
    publicCode: "cliproxy_provider_credentials_not_found",
    failureReason: code,
    message: "CLIProxyAPI provider credential is unavailable",
    retryable: false,
  };
  if (code === "model_cooldown") return {
    publicCode: "cliproxy_provider_credentials_cooldown",
    failureReason: code,
    message: "CLIProxyAPI provider credential is cooling down",
    retryable: true,
  };
  return null;
}

function isRetryableUpstreamCode(code: string): boolean {
  return /(?:^|_)(?:unavailable|upstream_5xx|stream_failed)(?:$|_)/i.test(code);
}

function cliProxyRequestError(status: number, upstreamType?: string): { code: string; message: string; status: number } | null {
  if (upstreamType === "invalid_request_error" || upstreamType === "bad_request_error" || status === 400) {
    return {
      code: "cliproxy_invalid_request",
      message: "Provider rejected the request as invalid",
      status: 400
    };
  }
  if (upstreamType === "not_found_error" || status === 404) {
    return {
      code: "cliproxy_not_found",
      message: "Provider could not find the requested resource",
      status: 404
    };
  }
  if (status === 409) {
    return {
      code: "cliproxy_conflict",
      message: "Provider rejected the request due to a conflict",
      status: 409
    };
  }
  if (status === 422) {
    return {
      code: "cliproxy_unprocessable_request",
      message: "Provider could not process the request",
      status: 422
    };
  }
  if (status >= 400 && status < 500 && status !== 408) {
    return {
      code: "cliproxy_provider_error",
      message: "CLIProxyAPI rejected the provider request",
      status
    };
  }
  return null;
}

export function cliProxyFetchError(error: unknown, signal?: AbortSignal): CliProxyError {
  if (error instanceof CliProxyError) return error;
  if (signal?.aborted) {
    if (signal.reason instanceof CliProxyError) return signal.reason;
    return new CliProxyError("cliproxy_request_aborted", "CLIProxyAPI request was cancelled", 499, {
      stage: "request",
      costExposure: "accruing",
      finalUsageEvidence: "pending",
      diagnostic: cliProxyDiagnostic("response_headers", false, 0, "ABORT_ERR")
    });
  }
  const causeCode = providerFetchCauseCode(error);
  return new CliProxyError("cliproxy_fetch_failed", "CLIProxyAPI request failed", 502, {
    retryable: true,
    stage: "response_headers",
    costExposure: "accruing",
    finalUsageEvidence: "pending",
    diagnostic: cliProxyDiagnostic("response_headers", true, 0, causeCode)
  });
}

export function cliProxyStreamError(error: unknown, eventsReceived: number, signal?: AbortSignal): CliProxyError {
  if (error instanceof CliProxyError) {
    if (error.diagnostic?.stage === "stream_read" && error.diagnostic.eventsReceived === eventsReceived) return error;
    return new CliProxyError(error.code, error.message, error.status, {
      retryable: error.retryable,
      stage: "stream_read",
      costExposure: error.costExposure,
      finalUsageEvidence: error.finalUsageEvidence,
      ...(error.failureReason ? { failureReason: error.failureReason } : {}),
      details: error.details,
      diagnostic: cliProxyDiagnostic("stream_read", error.retryable, eventsReceived, error.diagnostic?.causeCode)
    });
  }
  if (signal?.aborted) {
    const reason = signal.reason;
    const code = reason instanceof CliProxyError && reason.code === "cliproxy_timeout" ? "cliproxy_timeout" : "cliproxy_request_aborted";
    const message = code === "cliproxy_timeout" ? "CLIProxyAPI request timed out" : "CLIProxyAPI request was cancelled";
    return new CliProxyError(code, message, code === "cliproxy_timeout" ? 504 : 499, {
      retryable: code === "cliproxy_timeout",
      stage: "stream_read",
      costExposure: "accruing",
      finalUsageEvidence: "pending",
      diagnostic: cliProxyDiagnostic("stream_read", code === "cliproxy_timeout", eventsReceived, code === "cliproxy_timeout" ? "TIMEOUT" : "ABORT_ERR")
    });
  }
  const causeCode = providerFetchCauseCode(error);
  return new CliProxyError("cliproxy_stream_failed", "CLIProxyAPI stream ended unexpectedly", 502, {
    retryable: true,
    stage: "stream_read",
    costExposure: "accruing",
    finalUsageEvidence: "pending",
    diagnostic: cliProxyDiagnostic("stream_read", true, eventsReceived, causeCode)
  });
}

export function cliProxyErrorResponse(error: unknown): {
  status: number;
  failure: ProviderAttemptFailureV1;
  body: {
    error: {
      code: string;
      message: string;
      providerCode?: string;
      providerType?: string;
    };
  };
} {
  const normalized = error instanceof CliProxyError
    ? error
    : new CliProxyError("cliproxy_request_failed", "CLIProxyAPI request failed", 502, { retryable: true });
  const providerCode = safeErrorToken(normalized.details.upstreamCode);
  const providerType = safeErrorToken(normalized.details.upstreamType);
  return {
    status: normalized.status,
    failure: cliProxyAttemptFailure(normalized),
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(providerCode ? { providerCode } : {}),
        ...(providerType ? { providerType } : {})
      }
    }
  };
}

export function cliProxyAttemptFailure(error: CliProxyError): ProviderAttemptFailureV1 {
  return {
    version: 1,
    failureClass: error.code === "cliproxy_rate_limited"
      ? "rate_limited"
      : /timeout|lifetime|idle/.test(error.code)
        ? "timeout"
        : /fetch_failed|connect|socket/.test(error.code)
          ? "connect_error"
          : error.retryable && error.status >= 500
            ? "upstream_5xx"
            : "non_retryable",
    ...(error.failureReason ? { failureReason: error.failureReason } : {}),
    costExposure: error.costExposure,
    finalUsageEvidence: error.finalUsageEvidence,
  };
}

function cliProxyDiagnostic(
  stage: ProviderFetchDiagnosticV1["stage"],
  retryable: boolean,
  eventsReceived: number,
  causeCode?: string
): ProviderFetchDiagnosticV1 {
  const safeCauseCode = typeof causeCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(causeCode) ? causeCode : undefined;
  return {
    version: 1,
    stage,
    transport: "sse",
    retryable,
    eventsReceived: Math.max(0, Math.min(1_000_000, Math.floor(eventsReceived))),
    ...(safeCauseCode ? { causeCode: safeCauseCode } : {})
  };
}

function safeUpstreamError(body: unknown): { code?: string; type?: string } {
  const record = recordFromUnknown(body);
  const response = recordFromUnknown(record?.response);
  const nestedBody = recordFromUnknown(record?.body);
  const error = recordFromUnknown(record?.error)
    ?? recordFromUnknown(response?.error)
    ?? recordFromUnknown(nestedBody?.error);
  const code = safeErrorToken(error?.code ?? record?.code);
  const eventType = safeErrorToken(record?.type);
  const type = safeErrorToken(error?.type ?? record?.error_type ?? (
    eventType === "error" ? undefined : eventType
  ));
  return {
    ...(code ? { code } : {}),
    ...(type ? { type } : {})
  };
}

function safeErrorToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
