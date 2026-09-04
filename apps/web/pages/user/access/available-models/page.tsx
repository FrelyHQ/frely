import Link from "@web/navigation";
import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { userAccessDirectoryHref } from "../../../../features/access/lib/user-access-url-state";
import type { AvailableModelsPageData } from "./page.server";

export default function AvailableModelsPage({ data }: { data: AvailableModelsPageData }) {
  const { state, directory, metrics, userId } = data;
  return (
    <>
      <PageHeading eyebrow="Access / Available Models" title="Available Models" description="Review model summaries currently callable through your active plan."><StatusBadge tone="info">{metrics.totalModels} available</StatusBadge></PageHeading>
      <section className="summary-row">
        <MetricCard label="Available Models" value={String(metrics.totalModels)} detail="Visible and plan-entitled" {...(metrics.totalModels > 0 ? { tone: "good" as const } : {})} />
        <MetricCard label="API Families" value={String(metrics.apiFamilyCount)} detail={metrics.apiFamilyCount > 0 ? "Across visible models" : "None"} />
        <MetricCard label="Scope" value="User" detail={`user:${userId}`} maskDetail />
        <MetricCard label="Exposure" value="Summary" detail="Provider internals hidden" tone="good" />
      </section>
      <Card className="panel">
        <div className="panel-heading">
          <div><h2>Models</h2><p className="muted">Plan-entitled AccessPoint display names grouped as user-available model choices.</p></div>
          <form action="/user/access/available-models" className="row-actions" method="get">
            {state.pageSize !== 20 ? <input type="hidden" name="pageSize" value={state.pageSize} /> : null}
            <StatusBadge tone="info">{directory.total} results</StatusBadge>
            <label className="sr-only" htmlFor="user-available-model-query">Search Models</label>
            <input id="user-available-model-query" name="q" defaultValue={state.query} maxLength={100} placeholder="Search model, family, or Plan" />
            <Button type="submit" variant="secondary">Search</Button>
            {state.query ? <Button asChild type="button" variant="ghost"><Link href="/user/access/available-models">Clear</Link></Button> : null}
          </form>
        </div>
        <MaterialTable
          columns={["Model", "API Family", "Effective Price", "Source", "AccessPoint ID"].map((header) => ({ header }))}
          rows={directory.items.map((model) => ({
            id: model.accessPointId,
            cells: [
              <><strong data-clarity-mask="true">{model.displayName}</strong><AccessPointDescription description={model.description} /></>,
              model.apiFamily,
              <span data-clarity-mask="true">{formatEffectivePrice(model.effectivePrice ?? null)}</span>,
              <StatusBadge tone={model.effectivePrice?.source === "plan_access_point" ? "good" : "neutral"}>{model.effectivePrice?.source === "plan_access_point" ? "Plan override" : model.effectivePrice ? "AP base" : "Missing"}</StatusBadge>,
              <code data-clarity-mask="true">{model.accessPointId}</code>,
            ],
          }))}
          emptyState={{ title: "No models are currently available to this user." }}
        />
        <MaterialTablePagination page={directory.page} pageSize={directory.pageSize} totalPages={directory.totalPages} total={directory.total} previousHref={directory.page > 1 ? userAccessDirectoryHref("available-models", { ...state, page: directory.page - 1 }) : ""} nextHref={directory.page < directory.totalPages ? userAccessDirectoryHref("available-models", { ...state, page: directory.page + 1 }) : ""} noun="models" />
      </Card>
    </>
  );
}

function formatEffectivePrice(effectivePrice: { price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number; tiers?: Array<{ serviceTier?: string; tierKey: string; status: string }> } } | null) {
  if (!effectivePrice) return "Not configured";
  const price = effectivePrice.price;
  const enabledTiers = price.tiers?.filter((tier) => tier.status === "enabled") ?? [];
  const tierSuffix = enabledTiers.length === 0 ? " / flat" : ` / tiers ${enabledTiers.map((tier) => `${tier.serviceTier ?? "standard"}/${tier.tierKey}`).join(", ")}`;
  return `input ${formatCurrency(price.inputPer1M)} / cache read ${formatCurrency(price.cachedInputPer1M)} / cache write ${price.cacheWritePer1M === null ? "Unavailable" : formatCurrency(price.cacheWritePer1M)} / output ${formatCurrency(price.outputPer1M)}${tierSuffix}`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}
