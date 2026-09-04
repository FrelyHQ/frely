"use client";

import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  type CompleteAttachment,
  type ImageMessagePart,
} from "@assistant-ui/react";
import { SearchSelect, type SearchSelectOption } from "@frely/console-ui/search-select";
import { useMemo, useState } from "react";
import { useUserChatRuntime } from "../runtime/user-chat-runtime";
import { USER_CHAT_IMAGE_ACCEPT } from "../attachments/image-attachment-adapter";
import type { UserChatModelOption } from "../types";

export function UserChat({ models }: { models: UserChatModelOption[] }) {
  const modelOptions = useMemo<SearchSelectOption[]>(() => models.map((model) => ({
    value: model.model,
    label: model.model,
    description: `${model.label} / ${model.apiFamily}`,
    searchText: `${model.label} ${model.apiFamily}`,
  })), [models]);
  const [model, setModel] = useState(models[0]?.model ?? "");
  const runtime = useUserChatRuntime(model);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="user-chat-surface" aria-label="User chat">
        <div className="user-chat-toolbar">
          <label className="user-chat-model-field">
            <span>Model</span>
            <SearchSelect
              value={model}
              options={modelOptions}
              onValueChange={setModel}
              placeholder={models.length > 0 ? "Search available models" : "No available models"}
              disabled={models.length === 0}
              ariaLabel="Chat model"
            />
          </label>
          <NewChatButton />
        </div>
        <ThreadPrimitive.Root className="user-chat-thread">
          <ThreadPrimitive.Viewport className="user-chat-thread-viewport" autoScroll>
            <ThreadPrimitive.Empty>
              <div className="user-chat-empty">
                <p className="eyebrow">Start a conversation</p>
                <h2>How can I help?</h2>
                <p>Send a message to begin. You can attach one image to each message.</p>
              </div>
            </ThreadPrimitive.Empty>
            <div className="user-chat-message-list">
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            </div>
            <ThreadPrimitive.ViewportFooter className="user-chat-footer">
              {models.length > 0 ? <ChatComposer /> : <p className="user-chat-no-models">No user-visible models are available for this account.</p>}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </section>
    </AssistantRuntimeProvider>
  );
}

function NewChatButton() {
  const aui = useAui();
  return <button className="user-chat-new-button" type="button" onClick={() => aui.thread.reset()}>New chat</button>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="user-chat-message user-chat-message-user">
      <div className="user-chat-message-meta">You</div>
      <div className="user-chat-bubble">
        <MessagePrimitive.Parts />
        <MessagePrimitive.Attachments>
          {({ attachment }) => <MessageImageAttachment attachment={attachment} />}
        </MessagePrimitive.Attachments>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="user-chat-message user-chat-message-assistant">
      <div className="user-chat-message-meta">Assistant</div>
      <div className="user-chat-bubble">
        <MessagePrimitive.Parts />
        <MessagePrimitive.Error><p className="user-chat-message-error" role="alert">The assistant could not complete this request.</p></MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

function MessageImageAttachment({ attachment }: { attachment: CompleteAttachment }) {
  const image = attachment.content.find((part): part is ImageMessagePart => part.type === "image");
  return (
    <AttachmentPrimitive.Root className="user-chat-image-attachment">
      {image ? <img src={image.image} alt={attachment.name} /> : <span>{attachment.name}</span>}
    </AttachmentPrimitive.Root>
  );
}

function ChatComposer() {
  return (
    <ComposerPrimitive.Root className="user-chat-composer" compact>
      <ComposerPrimitive.Attachments>
        {({ attachment }) => (
          <AttachmentPrimitive.Root className="user-chat-pending-attachment">
            <span>{attachment.name}</span>
            <AttachmentPrimitive.Remove aria-label={`Remove ${attachment.name}`}>Remove</AttachmentPrimitive.Remove>
          </AttachmentPrimitive.Root>
        )}
      </ComposerPrimitive.Attachments>
      <div className="user-chat-composer-row">
        <ComposerPrimitive.AddAttachment className="user-chat-composer-action" multiple={false} aria-label="Add image">Add image</ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input className="user-chat-composer-input" placeholder="Message the assistant" submitMode="enter" />
        <ComposerPrimitive.Cancel className="user-chat-composer-action user-chat-composer-cancel">Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className="user-chat-composer-action user-chat-composer-send">Send</ComposerPrimitive.Send>
      </div>
      <p className="user-chat-composer-help">JPEG, PNG, or WebP up to 5 MiB. Enter to send, Shift+Enter for a new line.</p>
      <span className="sr-only">Accepted image types: {USER_CHAT_IMAGE_ACCEPT.replaceAll("image/", "").replaceAll(",", ", ")}.</span>
    </ComposerPrimitive.Root>
  );
}
