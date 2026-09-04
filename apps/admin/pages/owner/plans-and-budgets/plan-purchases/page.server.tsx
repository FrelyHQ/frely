import type { PlanPurchaseOrderStatus } from "@frely/ui-application/contracts";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { adminPageServices } from "../../../../lib/server";
import { ownerPlanPurchaseOrder } from "../../../../lib/plan-purchase";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const params = await searchParams;
  const status = single(params?.status);
  const filters = {
    status: validStatus(status) ? status : "",
    buyerUserId: single(params?.buyerUserId),
    planId: single(params?.planId),
    currency: single(params?.currency).toUpperCase(),
    listingPageSize: normalizeTablePageSize(params?.listingPageSize),
    orderPageSize: normalizeTablePageSize(params?.orderPageSize),
  };
  const listingFilter = {
    ...(filters.planId ? { planId: filters.planId } : {}),
    ...(filters.currency ? { paymentAsset: filters.currency } : {}),
    page: page(params?.listingPage),
    pageSize: filters.listingPageSize,
  };
  const orderFilter = {
    ...(filters.status ? { status: filters.status as PlanPurchaseOrderStatus } : {}),
    ...(filters.buyerUserId ? { buyerUserId: filters.buyerUserId } : {}),
    ...(filters.planId ? { planId: filters.planId } : {}),
    ...(filters.currency ? { paymentAsset: filters.currency } : {}),
    page: page(params?.orderPage),
    pageSize: filters.orderPageSize,
  };
  const listings = await admin.application.billingQueries.pagePlanPaymentListings(listingFilter);
  const rawOrders = await admin.application.billingQueries.pagePlanPurchaseOrders(orderFilter);
  const orders = {
    items: rawOrders.items.map(ownerPlanPurchaseOrder),
    page: rawOrders.page,
    pageSize: rawOrders.pageSize,
    total: rawOrders.total,
    totalPages: rawOrders.totalPages,
  };
  return { filters, listings, orders };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function single(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}


function page(value: string | string[] | undefined) {
  const parsed = Number(single(value));
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}


function validStatus(value: string): value is PlanPurchaseOrderStatus {
  return ["pending_payment", "fulfilled", "payment_failed", "cancelled", "expired", "reversed"].includes(value);
}
