"use client";

import { useMemo } from "react";
import { useLocalRuntime } from "@assistant-ui/react";
import { createUserChatAdapter } from "../api/user-chat-api";
import { UserChatImageAttachmentAdapter } from "../attachments/image-attachment-adapter";

export function useUserChatRuntime(model: string) {
  const chatModel = useMemo(() => createUserChatAdapter(model), [model]);
  const attachments = useMemo(() => new UserChatImageAttachmentAdapter(), []);
  return useLocalRuntime(chatModel, { adapters: { attachments } });
}
