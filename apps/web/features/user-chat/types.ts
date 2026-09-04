export interface UserChatModelOption {
  model: string;
  label: string;
  apiFamily: string;
}

export type UserChatMessageRole = "user" | "assistant";

export type UserChatMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface UserChatMessage {
  role: UserChatMessageRole;
  content: string | UserChatMessageContentPart[];
}

export interface UserChatResponse {
  ok: boolean;
  status: number;
  requestId: string | null;
  message?: string;
  errorMessage?: string;
}
