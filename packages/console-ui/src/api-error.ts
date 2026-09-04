export interface ConsoleApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    fieldErrors?: Record<string, string>;
  };
}

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly fieldErrors?: Record<string, string>;

  constructor(message: string, options: { status: number; code?: string; requestId?: string; fieldErrors?: Record<string, string> }) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.fieldErrors !== undefined) this.fieldErrors = options.fieldErrors;
  }
}

export type ConsoleResponseParser<T> = (value: unknown) => T;

export type ConsoleUiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "transient"
  | "unknown";

export interface ConsoleUiError {
  kind: ConsoleUiErrorKind;
  message: string;
  retryable: boolean;
  status: number | null;
  code: string | null;
  requestId: string | null;
  fieldErrors: Record<string, string>;
}

export async function readConsoleApiResponse<T>(
  response: Response,
  fallbackMessage: string,
  parser?: ConsoleResponseParser<T>,
): Promise<T> {
  const payload = await readJson(response);
  if (response.ok) {
    if (!parser) return payload as T;
    try {
      return parser(payload);
    } catch {
      throw new ConsoleApiError(`${fallbackMessage}: invalid response contract`, {
        status: 502,
        code: "invalid_response_contract",
      });
    }
  }
  const error = isErrorPayload(payload) ? payload.error : undefined;
  throw new ConsoleApiError(error?.message ?? fallbackMessage, {
    status: response.status,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.requestId ? { requestId: error.requestId } : {}),
    ...(error?.fieldErrors ? { fieldErrors: error.fieldErrors } : {})
  });
}

export function toConsoleUiError(cause: unknown, fallbackMessage: string): ConsoleUiError {
  if (cause instanceof ConsoleApiError) {
    return {
      kind: consoleUiErrorKind(cause.status),
      message: cause.message || fallbackMessage,
      retryable: cause.status === 408 || cause.status === 425 || cause.status === 429 || cause.status >= 500,
      status: cause.status,
      code: cause.code ?? null,
      requestId: cause.requestId ?? null,
      fieldErrors: cause.fieldErrors ?? {},
    };
  }
  return {
    kind: "unknown",
    message: cause instanceof Error && cause.message ? cause.message : fallbackMessage,
    retryable: false,
    status: null,
    code: null,
    requestId: null,
    fieldErrors: {},
  };
}

export function consoleErrorMessage(cause: unknown, fallbackMessage: string): string {
  return toConsoleUiError(cause, fallbackMessage).message;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isErrorPayload(value: unknown): value is ConsoleApiErrorPayload {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function consoleUiErrorKind(status: number): ConsoleUiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "validation";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 425 || status >= 500) return "transient";
  return "unknown";
}
