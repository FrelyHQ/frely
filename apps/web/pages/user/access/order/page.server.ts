import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { requireWebUserPage } from "../../../../lib/web-page";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const { services, claims } = await requireWebUserPage("/user/access/order");
  const modelPage = pageNumber(search.modelPage);
  const sourcePage = pageNumber(search.sourcePage);
  const modelPageSize = normalizeTablePageSize(search.modelPageSize);
  const sourcePageSize = normalizeTablePageSize(search.sourcePageSize);
  const models = await services.application.queries.pageUserAccessOrderModels(claims.sub, modelPage, modelPageSize);
  const requestedModel = first(search.model).trim().slice(0, 200);
  const selectedModel = requestedModel || models.items[0]?.exposedModel || "";
  const orders = selectedModel
    ? await services.application.queries.pageUserAccessOrder(claims.sub, { exposedModel: selectedModel, page: sourcePage, pageSize: sourcePageSize })
    : { items: [], page: 1, pageSize: sourcePageSize, total: 0, totalPages: 1, previousOrderId: null, nextOrderId: null, mode: "replace" as const };
  return { models, orders, selectedModel };
}

export type AccessOrderPageData = Awaited<ReturnType<typeof loadPage>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageNumber(value: string | string[] | undefined) {
  const raw = first(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
