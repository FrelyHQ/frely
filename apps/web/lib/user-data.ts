import type { UiSyncQueryPort, UserAvailableModelDirectoryRow } from "@frely/ui-application/contracts";
import type { IdentityQueries } from "@frely/identity/server";
import type { TenancyQueries } from "@frely/tenancy/server";
import {
  loadUserAudience,
  loadUserAudienceAsync,
  type UserAudienceApiKey,
  type UserAudienceCredit,
  type UserAudienceProfile,
  type UserAudienceAsyncApplicationOperationPort,
} from "@frely/tenancy/audience-server";

export interface WebUserConsoleView {
  user: UserAudienceProfile;
  apiKeys: UserAudienceApiKey[];
  apiKeyTotal: number;
  credit: UserAudienceCredit;
  accessPoints: Array<{
    accessPointId: string;
    displayName: string;
    description: string | null;
    apiFamily: string;
    exposedModel: string;
    effectivePrice: UserAvailableModelDirectoryRow["effectivePrice"];
  }>;
  userUsage: {
    totalTokens: number;
    billableAmount: number;
    calculatedCost: number;
  };
  maxApiKeyUsage: number;
  activeApiKeys: number;
}

export function buildWebUserConsoleView(
  repo: UiSyncQueryPort,
  identity: Pick<UiSyncQueryPort, "getUser">,
  tenancy: Pick<UiSyncQueryPort, "getTeam" | "getTeamMembership">,
  userId: string,
): WebUserConsoleView | null {
  const audience = loadUserAudience({
    repo,
    identity,
    tenancy,
    viewerUserId: userId,
    targetUserId: userId,
  });
  if (!audience?.apiKeys || !audience.credit || !audience.usage) return null;

  return {
    user: audience.user,
    apiKeys: audience.apiKeys.items,
    apiKeyTotal: audience.apiKeys.total,
    credit: audience.credit,
    accessPoints: repo.pageUserAvailableModels(userId).items,
    userUsage: audience.usage,
    maxApiKeyUsage: audience.apiKeys.summary.peakUsagePercent,
    activeApiKeys: audience.apiKeys.summary.activeKeys,
  };
}

export async function buildWebUserConsoleViewAsync(
  repo: UserAudienceAsyncApplicationOperationPort,
  identity: Pick<IdentityQueries, "getUser">,
  tenancy: Pick<TenancyQueries, "getTeam" | "getMembership">,
  userId: string,
): Promise<WebUserConsoleView | null> {
  const audience = await loadUserAudienceAsync({
    repo,
    identity,
    tenancy,
    viewerUserId: userId,
    targetUserId: userId,
  });
  if (!audience?.apiKeys || !audience.credit || !audience.usage) return null;
  const accessPoints = await repo.pageUserAvailableModels(userId);

  return {
    user: audience.user,
    apiKeys: audience.apiKeys.items,
    apiKeyTotal: audience.apiKeys.total,
    credit: audience.credit,
    accessPoints: accessPoints.items,
    userUsage: audience.usage,
    maxApiKeyUsage: audience.apiKeys.summary.peakUsagePercent,
    activeApiKeys: audience.apiKeys.summary.activeKeys,
  };
}
