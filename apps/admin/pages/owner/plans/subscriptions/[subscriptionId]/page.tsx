import { SubscriptionDetail } from "../../../../../features/plans/subscriptions/subscription-detail";
import type { AdminPageData } from "./page.server";

export default function SubscriptionDetailPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  return <SubscriptionDetail {...loaded} />;
}
