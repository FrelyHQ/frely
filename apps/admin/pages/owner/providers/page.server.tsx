import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import { providerOnboardingUiCapabilities } from "@frely/providers";
import { sanitizeProvider } from "@frely/ui-application/server";
import { adminPageServices } from "../../../lib/server";
import { parseShowRetainedProviders } from "../../../features/providers/lib/provider-retention";
import { editProviderFormDefaults } from "../../../features/providers/form/provider-form-values";
import { providerDirectoryRowData } from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const params = await searchParams;
  const showRetained = parseShowRetainedProviders(params?.showRetained);
  const directory = await admin.application.queries.pageProviderDirectory({ showRetained, page: pageNumber(params?.page), pageSize: normalizeTablePageSize(params?.pageSize) });
  const providerModels = await admin.application.modelAccessQueries.pageProviderModels(
    pageNumber(params?.modelPage),
    normalizeTablePageSize(params?.modelPageSize),
    { providerIds: directory.items.map((provider) => provider.id) },
  );
  const rows = directory.items.map((rawProvider) => {
    const provider = sanitizeProvider(rawProvider);
    return providerDirectoryRowData({
      ...provider,
      configJson: editProviderFormDefaults(provider).configJson,
    }, providerModels.items.filter((model) => model.providerId === provider.id));
  });
  const summary = await admin.application.queries.getProviderDirectorySummary();
  const hiddenRetainedCount = summary.retainedProviderCount;
  const capabilities = providerOnboardingUiCapabilities();
  return {
    showRetained,
    directory: pageMetadata(directory),
    providerModels: pageMetadata(providerModels),
    rows,
    summary,
    hiddenRetainedCount,
    capabilities,
  };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function pageNumber(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}

function pageMetadata(page: { page: number; pageSize: TablePageSize; total: number; totalPages: number }) {
  return { page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages };
}
