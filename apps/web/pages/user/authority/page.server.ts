import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { requireWebUserPage } from "../../../lib/web-page";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const { services, claims } = await requireWebUserPage("/user/authority");
  const productPage = pageNumber(search.productPage);
  const grantPage = pageNumber(search.grantPage);
  const productPageSize = normalizeTablePageSize(search.productPageSize);
  const grantPageSize = normalizeTablePageSize(search.grantPageSize);
  const [productResult, grantResult, canCreateTeam, creditAccount, providerSlotPage, currentPersonalProviderProduct] = await Promise.all([
    services.authorityEntitlement.commerce.pageAuthorityProducts(productPage, productPageSize, true),
    services.authorityEntitlement.authority.pageUserGrants(claims.sub, grantPage, undefined, grantPageSize),
    services.authorityEntitlement.authority.hasAvailableTeamCreationUnit(claims.sub),
    services.application.billingQueries.findCreditAccountForScope(`user:${claims.sub}`),
    services.authorityEntitlement.entitlement.pagePersonalProviderSlotsForUser(claims.sub, 1, 200),
    services.authorityEntitlement.commerce.findCurrentPersonalProviderProduct(),
  ]);
  const products = productResult.items.map((product) => ({
    id: product.id, code: product.code, version: product.version, displayName: product.displayName,
    effectCode: product.effectCode === "team_custom_provider_access" ? "team_custom_provider_access" as const : product.effectCode === "user_custom_provider_access" ? "user_custom_provider_access" as const : "team_create_unit" as const,
    grantUnits: product.grantUnits, purchaseAmountUnits: Number(product.purchaseAmountUnits), grantDurationSeconds: product.grantDurationSeconds, refundMode: product.refundMode, refundDeadlineSeconds: product.refundDeadlineSeconds, maxCurrentOwnedTeams: product.maxCurrentOwnedTeams, maxLifetimeCreatedTeams: product.maxLifetimeCreatedTeams,
  }));
  const grants = grantResult.items.map((grant) => ({ id: grant.id, productCode: grant.productCode, effectiveEnd: grant.effectiveEnd, lifecycle: grant.lifecycle, grantedUnits: grant.grantedUnits, usedUnits: grant.usedUnits, availableUnits: grant.availableUnits }));
  return {
    products: { ...productResult, items: products },
    grants: { ...grantResult, items: grants },
    canCreateTeam,
    personalCreditBalanceUnits: creditAccount?.balanceSnapUnits ?? 0,
    personalProviderProduct: currentPersonalProviderProduct ? {
      id: currentPersonalProviderProduct.id, code: currentPersonalProviderProduct.code, version: currentPersonalProviderProduct.version, displayName: currentPersonalProviderProduct.displayName, effectCode: "user_custom_provider_access" as const, grantUnits: currentPersonalProviderProduct.grantUnits, purchaseAmountUnits: Number(currentPersonalProviderProduct.purchaseAmountUnits), grantDurationSeconds: currentPersonalProviderProduct.grantDurationSeconds, refundMode: currentPersonalProviderProduct.refundMode, refundDeadlineSeconds: currentPersonalProviderProduct.refundDeadlineSeconds, maxCurrentOwnedTeams: currentPersonalProviderProduct.maxCurrentOwnedTeams, maxLifetimeCreatedTeams: currentPersonalProviderProduct.maxLifetimeCreatedTeams,
    } : null,
    providerSlots: providerSlotPage.items.map((slot) => ({ id: slot.id, providerId: slot.providerId, lifecycle: slot.lifecycle, latestEffectiveEnd: slot.latestEffectiveEnd, renewalCutoff: slot.renewalCutoff, usedAccessPoints: slot.usedAccessPoints, maxAccessPoints: slot.maxAccessPoints })),
    providerSlotTotal: providerSlotPage.total,
  };
}

export type UserAuthorityPageData = Awaited<ReturnType<typeof loadPage>>;

function pageNumber(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
