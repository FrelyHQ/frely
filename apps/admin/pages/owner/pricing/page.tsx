import { PricingView } from "../../../features/pricing";
import {
  pricingStateKey,
} from "../../../features/pricing/lib/pricing-url-state";
import type { AdminPageData } from "./page.server";

export default function PricingPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, providerPage, accessPointPage, summary, selectedProvider, ownerProfit } = loaded;
  return (
    <PricingView
      key={pricingStateKey(state)}
      initialState={{
        ...state,
        providerPage: providerPage.page,
        accessPointPage: accessPointPage.page,
      }}
      initialProviderRows={providerPage.items}
      initialProviderPage={providerPage}
      initialAccessPointRows={accessPointPage.items}
      initialAccessPointPage={accessPointPage}
      initialSelectedProvider={selectedProvider ? { id: selectedProvider.id, name: selectedProvider.name } : null}
      initialProviderModelCount={summary.providerModelCount}
      initialMissingProviderCostCount={summary.missingEnabledProviderCostCount}
      initialAccessPointCount={summary.accessPointCount}
      initialMissingAccessPointPriceCount={summary.missingEnabledAccessPointPriceCount}
      initialGlobalOwnerProfit={{
        salesAmount: ownerProfit.salesAmount,
        sourceCostAmount: ownerProfit.sourceCostAmount,
        providerCostAmount: ownerProfit.providerCostAmount,
        profitAmount: ownerProfit.profitAmount,
      }}
    />
  );
}
