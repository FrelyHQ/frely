import type { ImageMessagePart, ThreadMessage } from "@assistant-ui/react";
import type { UserChatMessage, UserChatMessageContentPart } from "../types";

/**
 * Convert assistant-ui's in-memory message shape into the deliberately narrow
 * User Chat API contract. Unsupported assistant-ui parts are ignored instead
 * of being forwarded as an accidental future protocol.
 */
export function toUserChatMessages(messages: readonly ThreadMessage[]): UserChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];

    const parts: UserChatMessageContentPart[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text) {
        parts.push({ type: "text", text: part.text });
      }
      if (message.role === "user" && part.type === "image") {
        parts.push(imagePart(part));
      }
    }

    if (message.role === "user") {
      for (const attachment of message.attachments ?? []) {
        for (const part of attachment.content ?? []) {
          if (part.type === "image") parts.push(imagePart(part));
        }
      }
    }

    if (parts.length === 0) return [];
    return [{
      role: message.role,
      content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts,
    }];
  });
}

function imagePart(part: ImageMessagePart): UserChatMessageContentPart {
  return { type: "image_url", image_url: { url: part.image } };
}
