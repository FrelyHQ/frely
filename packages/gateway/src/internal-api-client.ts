import { RelayError } from "@frely/core";
import { isIP } from "node:net";

export const DEFAULT_INTERNAL_GATEWAY_BASE_URL = "http://gateway-srv:43000";
export const DEFAULT_INTERNAL_GATEWAY_PRODUCTION_HOST_ALLOWLIST = ["gateway-srv:43000"] as const;

export type InternalGatewayApiPath = "/v1/chat/completions" | "/v1/responses" | "/v1/messages";

export interface InternalGatewayClientConfig {
  baseUrl: string;
}

export interface LoadInternalGatewayClientConfigOptions {
  production?: boolean;
  productionHostAllowlist?: readonly string[];
}

export interface InternalGatewayResponse {
  status: number;
  body: unknown;
  requestId: string | null;
}

type Fetch = typeof globalThis.fetch;

export function loadInternalGatewayClientConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadInternalGatewayClientConfigOptions = {}
): InternalGatewayClientConfig {
  const production = options.production ?? environment.NODE_ENV === "production";
  const baseUrl = validateInternalGatewayBaseUrl(
    environment.FRIDAY_RELAY_GATEWAY_INTERNAL_BASE_URL ?? DEFAULT_INTERNAL_GATEWAY_BASE_URL,
    {
      production,
      ...(options.productionHostAllowlist ? { productionHostAllowlist: options.productionHostAllowlist } : {})
    }
  );
  return { baseUrl };
}

export function validateInternalGatewayBaseUrl(
  value: string,
  options: LoadInternalGatewayClientConfigOptions = {}
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw internalGatewayConfigurationError("Internal Gateway base URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw internalGatewayConfigurationError("Internal Gateway base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw internalGatewayConfigurationError("Internal Gateway base URL must be an origin without userinfo, path, query, or fragment components");
  }
  if (!url.hostname) throw internalGatewayConfigurationError("Internal Gateway base URL host is required");
  if (options.production) {
    const allowlist = options.productionHostAllowlist ?? DEFAULT_INTERNAL_GATEWAY_PRODUCTION_HOST_ALLOWLIST;
    if (!allowlist.includes(url.host)) {
      throw internalGatewayConfigurationError("Internal Gateway production host is not allowed");
    }
  }
  return url.origin;
}

export class InternalGatewayClient {
  readonly config: InternalGatewayClientConfig;
  readonly #fetch: Fetch;

  constructor(config = loadInternalGatewayClientConfig(), fetchImplementation: Fetch = globalThis.fetch) {
    this.config = config;
    this.#fetch = fetchImplementation;
  }

  static fromEnv(environment: Readonly<Record<string, string | undefined>> = process.env): InternalGatewayClient {
    return new InternalGatewayClient(loadInternalGatewayClientConfig(environment));
  }

  async invoke(input: {
    path: InternalGatewayApiPath;
    apiKey: string;
    payload: Readonly<Record<string, unknown>>;
    requestId?: string;
    canonicalClientIp?: { header: "x-real-ip" | "cf-connecting-ip"; value: string } | null;
    signal?: AbortSignal;
  }): Promise<InternalGatewayResponse> {
    if (!isInternalGatewayApiPath(input.path)) {
      throw internalGatewayConfigurationError("Internal Gateway API path is not allowed");
    }
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new RelayError("api_key_value_unavailable", "API key material is unavailable for a real Gateway request", 409);
    if (input.canonicalClientIp && (input.canonicalClientIp.value.length > 64 || !isIP(input.canonicalClientIp.value))) {
      throw internalGatewayConfigurationError("Internal Gateway canonical client IP is invalid");
    }
    try {
      const response = await this.#fetch(`${this.config.baseUrl}${input.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(input.canonicalClientIp ? { [input.canonicalClientIp.header]: input.canonicalClientIp.value } : {}),
          ...(input.requestId ? { "x-request-id": input.requestId } : {})
        },
        body: JSON.stringify(input.payload),
        ...(input.signal ? { signal: input.signal } : {})
      });
      const body = await parseGatewayResponseBody(response);
      return {
        status: response.status,
        body,
        requestId: response.headers.get("x-request-id") ?? input.requestId ?? null
      };
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (error instanceof RelayError) throw error;
      throw new RelayError("gateway_unavailable", "Gateway API is unavailable", 503);
    }
  }
}

function isInternalGatewayApiPath(value: string): value is InternalGatewayApiPath {
  return value === "/v1/chat/completions" || value === "/v1/responses" || value === "/v1/messages";
}

async function parseGatewayResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function internalGatewayConfigurationError(message: string): RelayError {
  return new RelayError("internal_gateway_configuration_error", message, 500);
}
