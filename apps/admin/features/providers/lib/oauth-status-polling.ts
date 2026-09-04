import { ConsoleApiError } from "@frely/console-ui/api-error";

export interface ProviderOAuthStatusResult {
  status: "pending" | "ready";
}

export interface ProviderOAuthStatusPollingOptions {
  check: (signal: AbortSignal) => Promise<ProviderOAuthStatusResult>;
  onReady: () => void;
  onPending?: () => void;
  onTransientError: (code: string, nextDelayMs: number) => void;
  onTerminalError: (code: string) => void;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

const STABLE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{1,127}$/u;
const DEFAULT_INITIAL_DELAY_MS = 2_000;
const DEFAULT_MAXIMUM_DELAY_MS = 16_000;
const TRANSIENT_STATUS_ERROR_CODES = new Set([
  "cliproxy_control_rejected",
  "cliproxy_control_unavailable",
  "cliproxy_oauth_status_unavailable"
]);

export function startProviderOAuthStatusPolling(options: ProviderOAuthStatusPollingOptions): { cancel: () => void } {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maximumDelayMs = options.maximumDelayMs ?? DEFAULT_MAXIMUM_DELAY_MS;
  let active = true;
  let temporaryFailureCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  const cancel = () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    request?.abort();
  };

  const schedule = (delayMs: number) => {
    if (!active) return;
    timer = setTimeout(() => void poll(), delayMs);
  };

  const poll = async () => {
    if (!active) return;
    request = new AbortController();
    try {
      const result = await options.check(request.signal);
      if (!active) return;
      if (result.status === "ready") {
        active = false;
        options.onReady();
        return;
      }
      if (result.status !== "pending") {
        active = false;
        options.onTerminalError("cliproxy_oauth_status_invalid");
        return;
      }
      temporaryFailureCount = 0;
      options.onPending?.();
      schedule(initialDelayMs);
    } catch (cause) {
      if (!active || isAbortError(cause)) return;
      const failure = classifyProviderOAuthPollingError(cause);
      if (failure.terminal) {
        active = false;
        options.onTerminalError(failure.code);
        return;
      }
      const delayMs = Math.min(initialDelayMs * (2 ** temporaryFailureCount), maximumDelayMs);
      temporaryFailureCount += 1;
      options.onTransientError(failure.code, delayMs);
      schedule(delayMs);
    }
  };

  void poll();
  return { cancel };
}

export function safeProviderOperationCode(cause: unknown, fallback: string): string {
  const code = cause instanceof ConsoleApiError ? cause.code : errorCodeProperty(cause);
  return typeof code === "string" && STABLE_ERROR_CODE_PATTERN.test(code) ? code : fallback;
}

function classifyProviderOAuthPollingError(cause: unknown): { code: string; terminal: boolean } {
  const code = safeProviderOperationCode(cause, "cliproxy_oauth_status_unavailable");
  if (TRANSIENT_STATUS_ERROR_CODES.has(code)) return { code, terminal: false };
  if (cause instanceof ConsoleApiError && cause.code) return { code, terminal: true };
  if (cause instanceof ConsoleApiError && cause.status >= 400 && cause.status < 500) return { code, terminal: true };
  return { code, terminal: false };
}

function errorCodeProperty(cause: unknown): unknown {
  return cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}
