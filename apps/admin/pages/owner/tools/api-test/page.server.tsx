import { adminPageServices } from "../../../../lib/server";
import { PageHeading } from "../../_components/ui";
import { ApiTestWorkbench } from "../../../../features/api-test";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const services = await adminPageServices();
  if (!services) {
    return null;
  }
  return {  };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
