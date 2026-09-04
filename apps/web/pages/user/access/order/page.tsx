import Link from "@web/navigation";
import { PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import { Card } from "@frely/ui/components/card";
import { AccessOrderList } from "../../../../features/access-order";
import type { AccessOrderPageData } from "./page.server";

export default function AccessOrderPage({ data }: { data: AccessOrderPageData }) {
  const { models, orders, selectedModel } = data;
  return (
    <>
      <PageHeading eyebrow="Access / Order" title="Access Order" description="Choose a model, then arrange the Plan sources used when a Subscription budget or PayGo balance is exhausted."><StatusBadge tone="info">Per model</StatusBadge></PageHeading>
      <Card className="panel">
        <div className="panel-heading"><div><h2>Models</h2><p className="muted">Select a model before editing its source sequence.</p></div></div>
        <nav className="row-actions" aria-label="Access order models">
          {models.items.map((model) => <Link key={model.exposedModel} href={accessOrderHref(model.exposedModel, models.page, models.pageSize, 1, orders.pageSize)} aria-current={model.exposedModel === selectedModel ? "page" : undefined}>{model.exposedModel} ({model.sourceCount})</Link>)}
        </nav>
        <MaterialTablePagination page={models.page} pageSize={models.pageSize} total={models.total} totalPages={models.totalPages} pageParam="modelPage" pageSizeParam="modelPageSize" rangeStart={models.total ? (models.page - 1) * models.pageSize + 1 : 0} rangeEnd={Math.min(models.page * models.pageSize, models.total)} previousHref={models.page > 1 ? accessOrderHref("", models.page - 1, models.pageSize, 1, orders.pageSize) : ""} nextHref={models.page < models.totalPages ? accessOrderHref("", models.page + 1, models.pageSize, 1, orders.pageSize) : ""} noun="models" />
      </Card>
      <AccessOrderList key={`${selectedModel}:${orders.page}:${orders.items.map((item) => item.id).join(",")}`} initialItems={orders.items} mode={orders.mode} previousOrderId={orders.previousOrderId} nextOrderId={orders.nextOrderId} />
      {selectedModel ? <Card className="panel"><MaterialTablePagination page={orders.page} pageSize={orders.pageSize} total={orders.total} totalPages={orders.totalPages} pageParam="sourcePage" pageSizeParam="sourcePageSize" rangeStart={orders.total ? (orders.page - 1) * orders.pageSize + 1 : 0} rangeEnd={Math.min(orders.page * orders.pageSize, orders.total)} previousHref={orders.page > 1 ? accessOrderHref(selectedModel, models.page, models.pageSize, orders.page - 1, orders.pageSize) : ""} nextHref={orders.page < orders.totalPages ? accessOrderHref(selectedModel, models.page, models.pageSize, orders.page + 1, orders.pageSize) : ""} noun="sources" /></Card> : null}
    </>
  );
}

function accessOrderHref(model: string, modelPage: number, modelPageSize: TablePageSize, sourcePage: number, sourcePageSize: TablePageSize) {
  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (modelPage > 1) params.set("modelPage", String(modelPage));
  if (modelPageSize !== 20) params.set("modelPageSize", String(modelPageSize));
  if (sourcePage > 1) params.set("sourcePage", String(sourcePage));
  if (sourcePageSize !== 20) params.set("sourcePageSize", String(sourcePageSize));
  return `/user/access/order${params.size ? `?${params}` : ""}`;
}
