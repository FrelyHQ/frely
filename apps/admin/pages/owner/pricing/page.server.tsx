import { adminPageServices } from "../../../lib/server";
import {
  parsePricingWorkbenchState,
} from "../../../features/pricing/lib/pricing-url-state";
import {
  accessPointPriceWorkbenchPageData,
  providerCostWorkbenchPageData,
} from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { application } = admin;
  const state = parsePricingWorkbenchState((await searchParams) ?? {});
  const providerInput = {
    page: state.providerPage,
    pageSize: state.providerPageSize,
    providerId: state.providerId,
    modelStatus: state.providerModelStatus,
    price: state.providerPrice,
    query: state.providerQuery,
  };
  const accessPointInput = {
    page: state.accessPointPage,
    pageSize: state.accessPointPageSize,
    status: state.accessPointStatus,
    targetCost: state.accessPointTargetCost,
    price: state.accessPointPrice,
    query: state.accessPointQuery,
  };
  const rawProviderPage = await application.queries.pageProviderCostWorkbench(providerInput);
  const rawAccessPointPage = await application.queries.pageAccessPointPriceWorkbench(accessPointInput);
  const providerPage = providerCostWorkbenchPageData(rawProviderPage);
  const accessPointPage = accessPointPriceWorkbenchPageData(rawAccessPointPage);
  const summary = await application.queries.workbenchSummary();
  const selectedProviderRecord = state.providerId === "all"
    ? undefined
    : await application.queries.getProvider(state.providerId);
  const selectedProvider = selectedProviderRecord
    ? { id: selectedProviderRecord.id, name: selectedProviderRecord.name }
    : undefined;
  const ownerProfit = await application.queries.ownerProfitSummary("global:");
  return { state, providerPage, accessPointPage, summary, selectedProvider, ownerProfit };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
