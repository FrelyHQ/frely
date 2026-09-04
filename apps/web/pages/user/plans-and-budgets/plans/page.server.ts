import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { requireWebUserPage } from "../../../../lib/web-page";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const { services, view } = await requireWebUserPage("/user/plans-and-budgets/plans");
  const page = pageNumber(search.page);
  const pageSize = normalizeTablePageSize(search.pageSize);
  const plans = await services.application.billingQueries.pageUserStore(view.user.id, page, pageSize);
  const account = await services.application.billingQueries.findCreditAccountForScope(`user:${view.user.id}`);
  return {
    plans,
    creditBalanceUnits: account?.balanceSnapUnits ?? 0,
    returnOrderId: singleValue(search.planOrderId),
    returnCancelled: singleValue(search.stripe) === "cancelled",
  };
}

export type UserPlansPageData = Awaited<ReturnType<typeof loadPage>>;

function singleValue(value: string | string[] | undefined) {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved?.trim() || null;
}

function pageNumber(value: string | string[] | undefined) {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}
