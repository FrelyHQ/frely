import Link from "@admin/navigation";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { MetricCard, PageHeading, ProgressBar, StatusBadge } from "./_components/ui";
import { buildAdminDashboardAggregate, buildAdminDashboardAggregateAsync } from "../../lib/dashboard";
import { adminPageServices } from "../../lib/server";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const admin = await adminPageServices();
  if (!admin) return null;
  const { application, asyncTenancy } = admin;
  const dashboard = await buildAdminDashboardAggregateAsync(application.queries, asyncTenancy.tenancy);
  return { dashboard };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
