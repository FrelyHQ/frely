import { adminPageServices } from "../../../../lib/server";
import { AccessResolutionPreview } from "../../../../features/access-resolution";

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
