import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type {
  RemoveTeamMemberInput,
  UpdateTeamMemberApiKeyLimitInput,
} from "@frely/team-console-ui/models";

export async function updateWebTeamMemberApiKeyLimit(
  input: UpdateTeamMemberApiKeyLimitInput,
): Promise<unknown> {
  const response = await fetch(
    `/api/team/members/${encodeURIComponent(input.userId)}/api-key-limit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamId: input.teamId,
        apiKeyLimit: input.apiKeyLimit,
      }),
    },
  );
  return readConsoleApiResponse<unknown>(response, "Failed to update limit");
}

export async function removeWebTeamMember(input: RemoveTeamMemberInput): Promise<unknown> {
  const response = await fetch(
    `/api/team/members/${encodeURIComponent(input.userId)}/remove`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: input.teamId }),
    },
  );
  return readConsoleApiResponse<unknown>(response, "Failed to remove member");
}
