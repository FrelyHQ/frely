import { requireWebUserPage } from "../../../lib/web-page";

export async function loadPage() {
  const { claims, view } = await requireWebUserPage("/user/account");
  return { claims, view };
}

export type AccountPageData = Awaited<ReturnType<typeof loadPage>>;
