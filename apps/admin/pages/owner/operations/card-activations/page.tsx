import { CardActivationsPage } from "../../../../features/card-activations";
import type { AdminPageData } from "./page.server";

export default function CardActivationsRoute({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { initial } = loaded;
  return <CardActivationsPage initial={initial} />;
}
