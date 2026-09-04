import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { TeamSubscriptionCandidatePage } from "@frely/ui-application/contracts";

export async function fetchTeamPlanSubscriptionCandidates(
  teamId: string,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<TeamSubscriptionCandidatePage> {
  const params = new URLSearchParams({ teamId, page: String(page) });
  if (query.trim()) params.set("q", query.trim());
  const response = await fetch(`/api/team/plan-subscription-candidates?${params}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return readConsoleApiResponse(response, "Unable to load active Team Plan sources", parseCandidatePage);
}

function parseCandidatePage(value: unknown): TeamSubscriptionCandidatePage {
  if (!value || typeof value !== "object") throw new Error("The server returned an invalid Plan source page");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items)
    || !Number.isInteger(page.page)
    || page.pageSize !== 20
    || !Number.isInteger(page.total)
    || !Number.isInteger(page.totalPages)) {
    throw new Error("The server returned invalid Plan source pagination");
  }
  return page as unknown as TeamSubscriptionCandidatePage;
}
