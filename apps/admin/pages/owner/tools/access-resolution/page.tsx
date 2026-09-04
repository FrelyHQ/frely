import { AccessResolutionPreview } from "../../../../features/access-resolution";
import type { AdminPageData } from "./page.server";

export default function AccessResolutionToolPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  return <AccessResolutionPreview />;
}
