import { SubscriptionsOverview } from "../../../../features/plans/subscriptions/subscriptions-overview";
import type { AdminPageData } from "./page.server";

export default function SubscriptionsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, result, sources } = loaded;
  return <SubscriptionsOverview subscriptions={result.subscriptions} usage={result.usage} state={{ ...state, page: result.page }} pagination={result} calculatedAt={result.calculatedAt} sources={sources} />;
}
