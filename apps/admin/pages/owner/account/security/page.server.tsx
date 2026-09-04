import { PageHeading } from "@frely/console-ui";
import { OwnerPasswordChange } from "../../../../features/security";
import { adminPageServices } from "../../../../lib/server";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const admin = await adminPageServices();
  if (!admin) return null;
  return {};
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
