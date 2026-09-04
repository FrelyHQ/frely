import { PlanPurchasesView } from "../../../../features/plan-purchases";
import type { AdminPageData } from "./page.server";

export default function PlanPurchasesPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { filters, listings, orders } = loaded;
  return <PlanPurchasesView listings={listings} orders={orders} filters={filters} />;
}
