import { cardActivationBatchView } from "@frely/ui-application/server";
import { adminPageServices } from "../../../../lib/server";
import { CardActivationsPage } from "../../../../features/card-activations";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const params = await searchParams;
  const rawPage = Array.isArray(params?.page) ? params.page[0] : params?.page;
  const parsedPage = rawPage && /^\d+$/u.test(rawPage) ? Number(rawPage) : 1;
  const page = Number.isSafeInteger(parsedPage) && parsedPage >= 1 && parsedPage <= 10_000 ? parsedPage : 1;
  const loaded = await Promise.all([
      admin.application.billingQueries.listCardActivationBatches({ page, pageSize: 20 }),
      admin.application.billingQueries.getCardActivationStats(),
    ]);
  const initial = { ...loaded[0], stats: loaded[1], items: loaded[0].items.map((item) => ({ ...cardActivationBatchView(item), cardType: item.cardType as "plan" | "credit", stats: item.stats })) };
  return { initial };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
