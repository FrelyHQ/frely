export const API_TEST_TYPES = ["chat", "responses", "messages"] as const;

export type ApiTestType = typeof API_TEST_TYPES[number];
export type ApiTestGatewayKind = "chat.completions" | "responses" | "messages";

export interface ApiTestProtocol {
  type: ApiTestType;
  label: string;
  description: string;
  payloadLabel: string;
  gatewayKind: ApiTestGatewayKind;
  requestPath: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
  curlHeaders: ReadonlyArray<readonly [string, string]>;
}

const protocols = {
  chat: {
    type: "chat",
    label: "Chat Completions",
    description: "OpenAI-compatible chat messages",
    payloadLabel: "Chat Completions Payload",
    gatewayKind: "chat.completions",
    requestPath: "/v1/chat/completions",
    curlHeaders: []
  },
  responses: {
    type: "responses",
    label: "Responses",
    description: "OpenAI Responses input",
    payloadLabel: "Responses Payload",
    gatewayKind: "responses",
    requestPath: "/v1/responses",
    curlHeaders: []
  },
  messages: {
    type: "messages",
    label: "Messages",
    description: "Anthropic-compatible messages",
    payloadLabel: "Messages Payload",
    gatewayKind: "messages",
    requestPath: "/v1/messages",
    curlHeaders: [["anthropic-version", "2023-06-01"]]
  }
} as const satisfies Record<ApiTestType, ApiTestProtocol>;

export function apiTestProtocol(type: ApiTestType): ApiTestProtocol {
  return protocols[type];
}

export function isApiTestType(value: unknown): value is ApiTestType {
  return typeof value === "string" && API_TEST_TYPES.includes(value as ApiTestType);
}

export function apiTestTypeFromRequest(value: unknown): ApiTestType | null {
  if (value === undefined) return "chat";
  return isApiTestType(value) ? value : null;
}

export function defaultApiTestPayload(type: ApiTestType, model: string): Record<string, unknown> {
  if (type === "responses") return { model, input: "Say this is a test.", stream: false };
  if (type === "messages") {
    return {
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "Say this is a test." }],
      stream: false
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Say this is a test." }],
    stream: false
  };
}

export function apiTestPayloadValidationError(type: ApiTestType, payload: Record<string, unknown>): string | undefined {
  if (payload.stream === true) return "Owner API Test supports non-streaming requests only";
  if (type === "responses") {
    if (!("input" in payload) || payload.input === undefined || payload.input === null || payload.input === "") {
      return "Responses payload must include input";
    }
    return undefined;
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return `${type === "messages" ? "Messages" : "Chat Completions"} payload must include a non-empty messages array`;
  }
  if (type === "messages" && (!Number.isInteger(payload.max_tokens) || Number(payload.max_tokens) <= 0)) {
    return "Messages payload must include a positive integer max_tokens";
  }
  return undefined;
}
