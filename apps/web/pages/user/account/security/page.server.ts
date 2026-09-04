import { requireWebUserPage } from "../../../../lib/web-page";

export async function loadPage() {
  await requireWebUserPage("/user/account/security");
  return {};
}

export type AccountSecurityPageData = Awaited<ReturnType<typeof loadPage>>;
