import { PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import { PlanStore } from "../../../../features/plan-store";
import type { UserPlansPageData } from "./page.server";

export default function UserPlansPage({ data }: { data: UserPlansPageData }) {
  const { plans } = data;
  return (
    <>
      <PageHeading eyebrow="Plans & Budgets / Plans" title="Plans" description="Purchase a prepaid Plan Card for yourself, or keep it available to send or use later."><StatusBadge tone="info">Prepaid</StatusBadge></PageHeading>
      <PlanStore plans={plans.items} creditBalanceUnits={data.creditBalanceUnits} returnOrderId={data.returnOrderId} returnCancelled={data.returnCancelled} />
      <MaterialTablePagination page={plans.page} pageSize={plans.pageSize} total={plans.total} totalPages={plans.totalPages} previousHref={plans.page > 1 ? planStoreHref(plans.page - 1, plans.pageSize) : ""} nextHref={plans.page < plans.totalPages ? planStoreHref(plans.page + 1, plans.pageSize) : ""} noun="plans" />
    </>
  );
}

function planStoreHref(page: number, pageSize: TablePageSize) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  return `/user/plans-and-budgets/plans${params.size ? `?${params}` : ""}`;
}
