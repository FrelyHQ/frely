import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { WebRegistrationSettingView, WebRegistrationTeamCandidatePage } from "../types";

export async function fetchWebRegistrationTeamCandidates(query: string, cursor: string | null, signal?: AbortSignal): Promise<WebRegistrationTeamCandidatePage> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/owner/web-registration-team-candidates?${params}`, signal ? { signal } : {});
  return readConsoleApiResponse<WebRegistrationTeamCandidatePage>(response, "Load Team candidates failed");
}

export async function updateWebRegistrationSetting(teamId: string | null): Promise<WebRegistrationSettingView> {
  const response = await fetch("/api/owner/web-registration-settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId })
  });
  return readConsoleApiResponse<WebRegistrationSettingView>(response, "Save self-registration setting failed");
}
