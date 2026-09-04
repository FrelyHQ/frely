import type { ChatModelAdapter } from "@assistant-ui/react";
import { toUserChatMessages } from "../lib/user-chat-message-mapping";
import type { UserChatResponse } from "../types";

export function createUserChatAdapter(model: string): ChatModelAdapter {
  return {
    async run({ messages, abortSignal }) {
      const response = await fetch("/api/user/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: toUserChatMessages(messages) }),
        signal: abortSignal,
      });

      const result = await readResponse(response);
      if (!response.ok || !result.ok) {
        throw new Error(result.errorMessage ?? "The chat request could not be completed.");
      }
      if (!result.message) {
        throw new Error("The chat response did not include a message.");
      }

      return { content: [{ type: "text", text: result.message }] };
    },
  };
}

async function readResponse(response: Response): Promise<UserChatResponse> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object") {
      const result = value as Partial<UserChatResponse>;
      return {
        ok: result.ok === true,
        status: typeof result.status === "number" ? result.status : response.status,
        requestId: typeof result.requestId === "string" ? result.requestId : null,
        ...(typeof result.message === "string" ? { message: result.message } : {}),
        ...(typeof result.errorMessage === "string" ? { errorMessage: result.errorMessage } : {}),
      };
    }
  } catch {
    // The route intentionally exposes a stable fallback instead of raw errors.
  }
  return {
    ok: false,
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    errorMessage: "The chat request could not be completed.",
  };
}
