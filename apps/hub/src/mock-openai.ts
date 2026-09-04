import type { HubUpstream } from "./config.js";
import type { HubEndpoint } from "./executor.js";

export interface MockOpenAiInvokeInput {
  endpoint: HubEndpoint;
  targetModel: string;
  requestId: string;
  stream: boolean;
  payload: Record<string, unknown>;
}

export function mockOpenAiModels(upstream: HubUpstream): Map<string, { id: string }> {
  if (upstream.kind !== "mock-openai") return new Map();
  return new Map(upstream.models.map((id) => [id, { id }]));
}

export function invokeMockOpenAi(upstream: HubUpstream, input: MockOpenAiInvokeInput): Response {
  if (upstream.kind !== "mock-openai") {
    throw new Error("invokeMockOpenAi requires a mock-openai upstream");
  }
  const validationError = validateResponsesInput(input);
  if (validationError) return validationError;
  if (e2eErrorMode(input.payload) === "structured-invalid-request") {
    return Response.json({
      error: {
        message: "The E2E Provider rejected this request as invalid",
        type: "invalid_request_error",
        param: "input",
        code: "e2e_structured_invalid_request"
      }
    }, { status: 400 });
  }
  if (input.targetModel === "mock-local-fallback-primary") {
    return Response.json({
      error: {
        message: "Deterministic E2E retryable upstream failure",
        type: "server_error",
        code: "upstream_unavailable",
      },
    }, { status: 503 });
  }
  const text = upstream.responseText;
  if (input.stream && input.endpoint === "chat.completions") return mockChatCompletionStream(input, text);
  if (input.stream && input.endpoint === "responses") return mockResponsesStream(input, text);
  if (input.endpoint === "responses") {
    return Response.json({
      id: input.requestId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: input.targetModel,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      output_text: text,
      usage: mockResponsesUsage()
    });
  }
  if (input.endpoint === "messages") {
    return Response.json({
      id: input.requestId,
      type: "message",
      role: "assistant",
      model: input.targetModel,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: mockMessagesUsage()
    });
  }
  return Response.json({
    id: input.requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.targetModel,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: mockChatUsage()
  });
}

function validateResponsesInput(input: MockOpenAiInvokeInput): Response | null {
  if (input.endpoint !== "responses" || !Array.isArray(input.payload.input)) return null;
  for (const [index, item] of input.payload.input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") continue;
    if (item.id === undefined || (typeof item.id === "string" && item.id.startsWith("fc_"))) continue;
    return Response.json({
      error: {
        message: "Responses function_call item id must use the fc_ prefix",
        type: "invalid_request_error",
        param: `input[${index}].id`,
        code: "invalid_id_prefix"
      }
    }, { status: 400 });
  }
  return null;
}

function mockResponsesStream(input: MockOpenAiInvokeInput, text: string): Response {
  const id = input.requestId;
  const itemId = `${id}_message`;
  const output = [{ type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }];
  const streamMode = e2eStreamMode(input.payload);
  if (streamMode === "partial-error") {
    return delayedSse([
      { type: "response.created", response: { id, object: "response", status: "in_progress", model: input.targetModel, output: [] } },
      { type: "error", error: { code: "e2e_partial_stream_error" } }
    ], { terminal: false });
  }
  if (streamMode === "pre-chunk-error") {
    return delayedSse([
      { type: "error", error: { code: "e2e_pre_chunk_stream_error" } }
    ], { terminal: false });
  }
  if (streamMode === "slow-first-byte") {
    return delayedFirstByteSse([
      { type: "response.created", response: { id, object: "response", status: "in_progress", model: input.targetModel, output: [] } },
      { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text },
      { type: "response.completed", response: { id, object: "response", status: "completed", model: input.targetModel, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ], 350);
  }
  if (streamMode === "response-failed-clean-eof") {
    return delayedSse([
      { type: "response.failed", response: { id, object: "response", status: "failed", model: input.targetModel, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text },
      { type: "response.completed", response: { id, object: "response", status: "completed", model: input.targetModel, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ], { terminal: false });
  }
  if (streamMode === "active-long") {
    return intervalSse([
      { type: "response.created", response: { id, object: "response", status: "in_progress", model: input.targetModel, output: [] } },
      ...Array.from({ length: 15 }, (_, index) => ({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: index === 0 ? text : "."
      })),
      { type: "response.completed", response: { id, object: "response", status: "completed", model: input.targetModel, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ], 200, true);
  }
  if (streamMode === "large-output") {
    const delta = "x".repeat(3_500 * 1024);
    const terminalOutput = [{ type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: "complete", annotations: [] }] }];
    return delayedSse([
      { type: "response.created", response: { id, object: "response", status: "in_progress", model: input.targetModel, output: [] } },
      ...Array.from({ length: 5 }, () => ({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta
      })),
      { type: "response.completed", response: { id, object: "response", status: "completed", model: input.targetModel, output: terminalOutput, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ]);
  }
  if (streamMode === "hard-lifetime") {
    return repeatingSse(
      (index) => index === 0
        ? { type: "response.created", response: { id, object: "response", status: "in_progress", model: input.targetModel, output: [] } }
        : { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: "." },
      200
    );
  }
  return delayedSse([
    { type: "response.created", response: { id, object: "response", status: "in_progress", model: input.targetModel, output: [] } },
    { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text },
    { type: "response.completed", response: {
      id,
      object: "response",
      status: "completed",
      model: input.targetModel,
      output,
      usage: mockResponsesUsage(),
    } }
  ]);
}

function mockChatCompletionStream(input: MockOpenAiInvokeInput, text: string): Response {
  const created = Math.floor(Date.now() / 1000);
  const frames = [
    { id: input.requestId, object: "chat.completion.chunk", created, model: input.targetModel, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: input.requestId, object: "chat.completion.chunk", created, model: input.targetModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  ];
  return delayedSse(frames);
}

function delayedFirstByteSse(frames: readonly unknown[], delayMs: number): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        if (cancelled) return;
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(withExactMockUsage(frame))}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }, delayMs);
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function delayedSse(frames: readonly unknown[], options: { terminal?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(withExactMockUsage(frames[0]))}\n\n`));
      timer = setTimeout(() => {
        if (cancelled) return;
        for (const frame of frames.slice(1)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(withExactMockUsage(frame))}\n\n`));
        if (options.terminal !== false) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }, 25);
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function intervalSse(frames: readonly unknown[], intervalMs: number, terminal: boolean): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = () => {
        const frame = frames[index++];
        if (frame !== undefined) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(withExactMockUsage(frame))}\n\n`));
          return;
        }
        if (timer) clearInterval(timer);
        if (terminal) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
      emit();
      timer = setInterval(emit, intervalMs);
    },
    cancel() {
      if (timer) clearInterval(timer);
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function repeatingSse(frame: (index: number) => unknown, intervalMs: number): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = () => controller.enqueue(encoder.encode(`data: ${JSON.stringify(withExactMockUsage(frame(index++)))}\n\n`));
      emit();
      timer = setInterval(emit, intervalMs);
    },
    cancel() {
      if (timer) clearInterval(timer);
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function mockResponsesUsage(): Record<string, unknown> {
  return {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  };
}

function mockChatUsage(): Record<string, unknown> {
  return {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  };
}

function mockMessagesUsage(): Record<string, unknown> {
  return {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function withExactMockUsage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withExactMockUsage);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const output = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, withExactMockUsage(child)]));
  const usage = output.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return output;
  const usageRecord = usage as Record<string, unknown>;
  if ("prompt_tokens" in usageRecord) output.usage = { ...mockChatUsage(), ...usageRecord };
  else if ("total_tokens" in usageRecord) output.usage = { ...mockResponsesUsage(), ...usageRecord };
  else output.usage = { ...mockMessagesUsage(), ...usageRecord };
  return output;
}

function e2eStreamMode(payload: Record<string, unknown>): string | null {
  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const mode = (metadata as Record<string, unknown>).friday_relay_e2e_stream_mode;
  return typeof mode === "string" ? mode : null;
}

function e2eErrorMode(payload: Record<string, unknown>): string | null {
  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const mode = (metadata as Record<string, unknown>).friday_relay_e2e_error_mode;
  return typeof mode === "string" ? mode : null;
}
