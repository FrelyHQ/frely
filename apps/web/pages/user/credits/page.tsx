import { UserCreditAudienceView } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { CreditTopup } from "../../../features/credit-topups";
import { userCreditsHref } from "../../../features/credit-topups/lib/credit-history-url";
import type { UserCreditsPageData } from "./page.server";

export default function UserCreditsPage({ data }: { data: UserCreditsPageData }) {
  const { model, requestedState } = data;
  const topupNextHref = model.topups.nextCursor ? userCreditsHref({ ...requestedState, topupCursor: model.topups.nextCursor, ledgerCursor: model.ledger.acceptedCursor }) : "";
  const ledgerNextHref = model.ledger.nextCursor ? userCreditsHref({ ...requestedState, topupCursor: model.topups.acceptedCursor, ledgerCursor: model.ledger.nextCursor }) : "";
  return <UserCreditAudienceView
    model={model}
    topupExperience={<CreditTopup listings={model.catalog.listings} topups={model.topups.items} historyPagination={<MaterialTablePagination page={1} pageSize={model.topups.pageSize} pageSizeParam="topupPageSize" resetParams={["topupCursor"]} total={model.topups.items.length} totalMode="unknown" totalPages={1} nextHref={topupNextHref} noun="topup requests" />} />}
    ledgerPagination={<MaterialTablePagination page={1} pageSize={model.ledger.pageSize} pageSizeParam="ledgerPageSize" resetParams={["ledgerCursor"]} total={model.ledger.items.length} totalMode="unknown" totalPages={1} nextHref={ledgerNextHref} noun="ledger events" />}
    catalogPagination={<MaterialTablePagination page={model.catalog.page} pageSize={model.catalog.pageSize} total={model.catalog.total} totalPages={model.catalog.totalPages} pageParam="catalogPage" pageSizeParam="catalogPageSize" previousHref={model.catalog.page > 1 ? userCreditsHref({ ...requestedState, catalogPage: model.catalog.page - 1 }) : ""} nextHref={model.catalog.page < model.catalog.totalPages ? userCreditsHref({ ...requestedState, catalogPage: model.catalog.page + 1 }) : ""} noun="credit products" />}
  />;
}
