import { readConsoleApiResponse } from "@frely/console-ui/api-error";

export interface AcceptInviteInput { inviteToken: string; email?: string; password?: string }
export interface AcceptInviteResult {
  outcome?: "joined" | "already_joined" | string;
  accountOutcome?: "created" | "already_registered";
}

export async function acceptInvite({ inviteToken, ...body }: AcceptInviteInput) {
  const response = await fetch(`/api/invite-links/${encodeURIComponent(inviteToken)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return readConsoleApiResponse<AcceptInviteResult>(response, "Failed to accept invite");
}

export async function acceptLandingInvite(body: Omit<AcceptInviteInput, "inviteToken">) {
  const response = await fetch("/api/landing-registration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return readConsoleApiResponse<AcceptInviteResult>(response, "Failed to register");
}

export async function registerSelf(input: { entry: "global" | "partner"; email: string; password: string }) {
  const response = await fetch(`/api/self-registration?entry=${encodeURIComponent(input.entry)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: input.email, password: input.password })
  });
  return readConsoleApiResponse<AcceptInviteResult>(response, "Failed to register");
}
