import { PlansView } from "../../../../features/plans";
import type { AdminPageData } from "./page.server";

export default function PlansPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, directory } = loaded;
  return <PlansView
    state={{ ...state, page: directory.page }}
    directory={{
      ...directory,
      items: directory.items.map((plan) => ({
        id: plan.id,
        ownerId: plan.ownerId,
        scopeRef: plan.scopeRef,
        name: plan.name,
        version: plan.version,
        description: plan.description,
        adminNote: plan.adminNote,
        billingMode: plan.billingMode as "prepaid" | "paygo",
        purchaseAmount: plan.purchaseAmount,
        durationSeconds: plan.durationSeconds,
        status: plan.planStatus as "enabled" | "closed" | "disabled",
        catalogStatus: plan.catalogStatus,
        statusImpact: {
          availableCardCount: plan.availableCardCount,
          activeOrFutureSubscriptionCount: plan.activeOrFutureSubscriptionCount,
        },
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        budgetLimitCount: plan.budgetLimitCount,
        accessPointCount: plan.accessPointCount,
        accessPointNames: plan.accessPointNames,
      })),
    }}
  />;
}
