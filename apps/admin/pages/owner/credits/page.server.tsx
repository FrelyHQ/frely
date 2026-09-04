import { CreditCursorError, type UiQueryPort } from "@frely/ui-application/server";
import { buildAdminCreditsAggregateAsync } from "../../../lib/teams";
import { adminPageServices } from "../../../lib/server";
import { parseAdminCreditsUrlState } from "../../../features/credits/lib/credit-url-state";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { application } = admin;
  const params = await searchParams;
  const state = parseAdminCreditsUrlState(params);
  const { query, page, pageSize, scopePage, scopePageSize, configurationPage, configurationPageSize, topupCursor: requestedTopupCursor, topupPageSize } = state;
  const credits = await buildAdminCreditsAggregateAsync(application.billingQueries, { query, page, pageSize, scopePage, scopePageSize });
  const topupPage = await safeAdminTopupPageAsync(application.billingQueries, requestedTopupCursor, topupPageSize);
  const topups = topupPage.items;
  const configuration = await application.billingQueries.getAdminCreditConfigurationSummary();
  const draftChannelPage = await application.billingQueries.pageDraftPaymentChannels(configurationPage, configurationPageSize);
  const draftChannels = draftChannelPage.items.map((channel) => ({
    id: channel.id,
    code: channel.code,
    displayName: channel.displayName,
    paymentNetwork: channel.paymentNetwork,
    paymentAsset: channel.paymentAsset,
    status: channel.status,
    instructionAttachments: [],
  }));
  return {
    state,
    requestedTopupCursor,
    credits,
    topupPage: { nextCursor: topupPage.nextCursor },
    topups,
    configuration,
    draftChannelPage: {
      page: draftChannelPage.page,
      pageSize: draftChannelPage.pageSize,
      total: draftChannelPage.total,
      totalPages: draftChannelPage.totalPages,
    },
    draftChannels,
  };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

async function safeAdminTopupPageAsync(billingQueries: Pick<UiQueryPort, "cursorAdminTopups">, cursor: string, pageSize: number) {
  try {
    return await billingQueries.cursorAdminTopups(cursor || undefined, undefined, undefined, pageSize);
  } catch (error) {
    if (error instanceof CreditCursorError) return billingQueries.cursorAdminTopups(undefined, undefined, undefined, pageSize);
    throw error;
  }
}
