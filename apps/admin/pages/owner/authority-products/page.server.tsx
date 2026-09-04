import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import type { AuthorityProductSnapshot } from "@frely/billing/server";
import { AUTHORITY_PRODUCT_LIMITS, RelayError } from "@frely/core";
import { adminPageServices } from "../../../lib/server";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const owner = await adminPageServices();
  if (!owner) return null;
  const params = await searchParams;
  const page = pageNumber(singleValue(params?.page));
  const pageSize = normalizeTablePageSize(params?.pageSize);
  const rawProducts = await owner.authorityEntitlement.commerce.pageAuthorityProducts(page, pageSize);
  const products = {
    items: rawProducts.items.map(ownerAuthorityProduct),
    page: rawProducts.page,
    pageSize: rawProducts.pageSize,
    total: rawProducts.total,
    totalPages: rawProducts.totalPages,
  };
  return { products };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function singleValue(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }

function pageNumber(value: string): number { const page = Number(value); return Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1; }

function ownerAuthorityProduct(product: AuthorityProductSnapshot) {
  return {
    id: product.id,
    displayName: product.displayName,
    code: product.code,
    version: product.version,
    effectCode: product.effectCode,
    grantUnits: product.grantUnits,
    purchaseAmountUnits: authorityPurchaseAmountUnits(product.purchaseAmountUnits),
    grantDurationSeconds: product.grantDurationSeconds,
    lifecycle: product.lifecycle,
  };
}

function authorityPurchaseAmountUnits(value: bigint): number {
  if (value < 1n || value > BigInt(AUTHORITY_PRODUCT_LIMITS.maxPurchaseAmountUnits)) {
    throw new RelayError("authority_integer_out_of_range", "Authority purchase amount is outside the supported range", 500);
  }
  return Number(value);
}
