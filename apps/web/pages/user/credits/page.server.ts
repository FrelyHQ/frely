import { notFound } from "@web/navigation";
import { loadUserCreditAudienceAsync } from "@frely/tenancy/audience-server";
import { requireWebUserSession } from "../../../lib/web-page";
import { parseCreditHistoryUrlState } from "../../../features/credit-topups/lib/credit-history-url";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const { services, claims } = await requireWebUserSession("/user/credits");
  const requestedState = parseCreditHistoryUrlState(search);
  await services.application.billingCommands.expireCreditTopups(undefined, claims.sub);
  const model = await loadUserCreditAudienceAsync({
    repo: services.application.billingQueries,
    identity: services.asyncTenancy.identity,
    userId: claims.sub,
    topupCursor: requestedState.topupCursor,
    topupPageSize: requestedState.topupPageSize,
    ledgerCursor: requestedState.ledgerCursor,
    ledgerPageSize: requestedState.ledgerPageSize,
    catalogPage: requestedState.catalogPage,
    catalogPageSize: requestedState.catalogPageSize,
  });
  if (!model) notFound();
  return { model, requestedState };
}

export type UserCreditsPageData = Awaited<ReturnType<typeof loadPage>>;
