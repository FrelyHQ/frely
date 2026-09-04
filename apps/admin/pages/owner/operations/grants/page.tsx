import { BatchGrantsPage } from "../../../../features/batch-grants";
import type { AdminPageData } from "./page.server";

export default function BatchGrantsRoute({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { view } = loaded;
  return <BatchGrantsPage {...(view ? { detail: view } : {})} />;
}
