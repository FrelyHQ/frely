import { RelayError } from "@frely/core";
import { handleUniversalStreamRequest, translateBetweenProviders, type ProviderType } from "llm-bridge";

export type HubProviderFormat = Extract<ProviderType, "openai" | "openai-responses" | "anthropic">;

export function hubFormatForEndpoint(endpoint: "chat.completions" | "responses" | "messages"): HubProviderFormat {
  if (endpoint === "messages") return "anthropic";
  if (endpoint === "responses") return "openai-responses";
  return "openai";
}

export function translateHubRequest(source: HubProviderFormat, target: HubProviderFormat, payload: Record<string, unknown>): Record<string, unknown> {
  if (source === target) return payload;
  try {
    assertHubRequestConvertible(source, target, payload);
    return translateBetweenProviders(source, target, payload as never) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError("unsupported_protocol_feature", `Unable to convert ${source} request to ${target}`, 400);
  }
}

export function translateHubStream(source: HubProviderFormat, target: HubProviderFormat, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (source === target) return stream;
  try {
    return handleUniversalStreamRequest(stream, source, target) as ReadableStream<Uint8Array>;
  } catch {
    throw new RelayError("unsupported_protocol_feature", `Unable to convert ${source} stream to ${target}`, 400);
  }
}

export function extractTextFromProviderResponse(format: HubProviderFormat, body: Record<string, unknown>): string {
  if (format === "anthropic") {
    const content = body.content;
    if (Array.isArray(content)) {
      return content.map((item) => record(item)?.text).filter((text): text is string => typeof text === "string").join("");
    }
  }
  if (format === "openai-responses") {
    if (typeof body.output_text === "string") return body.output_text;
    if (Array.isArray(body.output)) {
      return body.output.flatMap((item) => {
        const content = record(item)?.content;
        return Array.isArray(content) ? content : [];
      }).map((item) => record(item)?.text).filter((text): text is string => typeof text === "string").join("");
    }
  }
  if (Array.isArray(body.choices)) {
    return body.choices.map((choice) => record(record(choice)?.message)?.content).filter((text): text is string => typeof text === "string").join("");
  }
  return "";
}

export function providerResponseToHubResponse(
  source: HubProviderFormat,
  target: HubProviderFormat,
  body: Record<string, unknown>,
  options: { requestId: string; model: string; text: string }
): Record<string, unknown> {
  if (source === target) return body;
  const created = Math.floor(Date.now() / 1000);
  if (target === "anthropic") {
    return {
      id: options.requestId,
      type: "message",
      role: "assistant",
      model: options.model,
      content: [{ type: "text", text: options.text }],
      stop_reason: "end_turn",
      stop_sequence: null
    };
  }
  if (target === "openai-responses") {
    return {
      id: options.requestId,
      object: "response",
      created_at: created,
      status: "completed",
      model: options.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: options.text, annotations: [] }] }],
      output_text: options.text
    };
  }
  return {
    id: options.requestId,
    object: "chat.completion",
    created,
    model: options.model,
    choices: [{ index: 0, message: { role: "assistant", content: options.text }, finish_reason: "stop" }]
  };
}

function assertHubRequestConvertible(source: HubProviderFormat, target: HubProviderFormat, payload: Record<string, unknown>): void {
  if (source !== target && containsKey(payload, "prompt_cache_breakpoint")) {
    throw new RelayError("unsupported_protocol_feature", "Prompt cache breakpoints cannot be converted losslessly between provider protocols", 400);
  }
  if (source !== "openai-responses" || target === "openai-responses") return;
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.some((tool) => record(tool)?.type !== "function")) {
    throw new RelayError("unsupported_protocol_feature", "OpenAI Responses built-in tools cannot be converted to Claude or Chat Completions", 400);
  }
  if (!Array.isArray(payload.input)) return;
  if (payload.input.some((item) => {
    const value = record(item);
    return value && typeof value.type === "string" && value.type !== "message";
  })) {
    throw new RelayError("unsupported_protocol_feature", "OpenAI Responses item graph cannot be converted to Claude or Chat Completions", 400);
  }
}

function containsKey(value: unknown, key: string, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key, seen));
  const valueRecord = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(valueRecord, key) || Object.values(valueRecord).some((item) => containsKey(item, key, seen));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
