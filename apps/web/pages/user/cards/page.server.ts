import { requireWebUserPage } from "../../../lib/web-page";

export async function loadPage() {
  await requireWebUserPage("/user/cards");
  return {};
}

export type UserCardsPageData = Awaited<ReturnType<typeof loadPage>>;
